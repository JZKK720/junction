/* ==========================================================================
   messages.js — Chat message row rendering (user/assistant rows,
                  history builder, setAssistantText, pill helpers)
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv_m = document.getElementById('chat-messages');
  var pinnedThrobber_m = document.getElementById('pinned-anim-throbber');

  // ── State ─────────────────────────────────────────────────────────────────
  var activeRuns = new Map();        // runId → assistant row element
  var runSubagentInfo = new Map();   // runId → subagent metadata
  var reasoningBlocks = new Map();   // runId → current (latest) <details> segment
  var reasoningInterrupted = new Set(); // runIds whose next thinking opens a new segment
  var toolCalls = new Map();         // toolCallId → tool card element
  var toolContainers = new Map();    // runId → .tool-calls container
  var activityNoteState = new Map(); // runId → { buffer: string }
  var activityTextState = new Map(); // runId → latest assistant stream text
  var thinkingTextState = new Map(); // runId → latest thinking stream text
  var isRestoringHistory = false;
  var userScrollSticky = true;
  var isProgrammaticScroll = false;
  var historyFragment = null;

  window.activeRuns = activeRuns;
  window.runSubagentInfo = runSubagentInfo;
  window.reasoningBlocks = reasoningBlocks;
  window.reasoningInterrupted = reasoningInterrupted;
  window.toolCalls = toolCalls;
  window.toolContainers = toolContainers;
  window.activityNoteState = activityNoteState;
  window.activityTextState = activityTextState;
  window.thinkingTextState = thinkingTextState;
  window.isRestoringHistory = isRestoringHistory;
  window.userScrollSticky = userScrollSticky;
  window.isProgrammaticScroll = isProgrammaticScroll;
  window.historyFragment = historyFragment;
  window.messageReactionsEnabled = false;

  // ── Workspace context detection ──────────────────────────────────────────
  var WORKSPACE_PREFIXES = ['Chat: VS Code.', 'This session is driven', '[Workspace File Context]', '[Attached Context]'];
  var WORKSPACE_MARKERS = ['treat paths as relative to workspace'];

  function isWorkspaceContext(text) {
    if (!text) return false;
    var t = text.trim();
    if (WORKSPACE_PREFIXES.some(function (p) { return t.startsWith(p); })) return true;
    if (WORKSPACE_MARKERS.some(function (m) { return t.includes(m); })) return true;
    return false;
  }
  window.isWorkspaceContext = isWorkspaceContext;

  // ── Subagent label ───────────────────────────────────────────────────────
  function applySubagentLabel(row, info) {
    if (row.querySelector('.subagent-label')) return;
    var label = document.createElement('div');
    label.className = 'subagent-label';
    label.textContent = '[' + (info.subagentRole || 'Subagent') + ']' +
      (info.spawnDepth ? ' (D' + info.spawnDepth + ')' : '');
    row.insertBefore(label, row.firstChild);
  }

  function ensureActivityStream(row) {
    var stream = row.querySelector('.assistant-activity');
    if (!stream) {
      stream = document.createElement('div');
      stream.className = 'assistant-activity';
      row.insertBefore(stream, row.querySelector('.msg-text') || row.firstChild);
    }
    return stream;
  }
  window.ensureActivityStream = ensureActivityStream;

  function activityUsesUnifiedTimeline() {
    var body = document.body;
    return body.classList.contains('stream-layout-timeline');
  }
  window.activityUsesUnifiedTimeline = activityUsesUnifiedTimeline;

  function formatWorkedDuration(ms) {
    var total = Math.max(1, Math.round((ms || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    if (minutes > 0) return minutes + 'm ' + seconds + 's';
    return seconds + 's';
  }

  function ensureWorklog(row) {
    var stream = ensureActivityStream(row);
    var worklog = row.querySelector('.activity-worklog');
    if (!worklog) {
      worklog = document.createElement('details');
      worklog.className = 'activity-worklog';
      worklog.open = true;
      worklog.innerHTML = '<summary class="activity-worklog-summary"><span class="thinking-throbber" aria-hidden="true"></span><span class="activity-worklog-label">Working...</span><span class="codicon codicon-chevron-right activity-worklog-toggle" aria-hidden="true"></span></summary><div class="activity-worklog-body"></div>';
      stream.appendChild(worklog);
    }
    return worklog;
  }
  window.ensureWorklog = ensureWorklog;

  function setWorklogState(runId, state, durationMs) {
    var row = (runId && window.activeRuns.get(runId)) || document.querySelector('[data-run-id="' + runId + '"]');
    if (!row) return;
    var worklog = ensureWorklog(row);
    var label = worklog.querySelector('.activity-worklog-label');
    if (!label) return;
    var compactTimeline = !!window.compactTimelineMode && activityUsesUnifiedTimeline();
    if (worklog.getAttribute('data-thinking-text')) {
      updateActivityWorklogThoughtSummary(worklog);
      worklog.classList.toggle('thinking', state !== 'done');
      if (compactTimeline) worklog.open = state !== 'done';
      return;
    }
    if (state === 'done') {
      worklog.classList.remove('thinking');
      var started = parseInt(row.getAttribute('data-run-start-ms') || '0', 10);
      var elapsed = durationMs || (started ? (Date.now() - started) : 0);
      row.setAttribute('data-work-duration-ms', String(elapsed));
      label.textContent = window.junctionT('workedFor', 'Worked for {duration}', { duration: formatWorkedDuration(elapsed) });
      if (compactTimeline) worklog.open = false;
    } else {
      worklog.classList.add('thinking');
      label.textContent = window.junctionT('working', 'Working...');
      if (compactTimeline) worklog.open = true;
    }
  }
  window.setWorklogState = setWorklogState;

  function updateActivityWorklogThoughtSummary(worklogOrRow) {
    var worklog = worklogOrRow && worklogOrRow.classList && worklogOrRow.classList.contains('activity-worklog')
      ? worklogOrRow
      : (worklogOrRow && worklogOrRow.querySelector && worklogOrRow.querySelector('.activity-worklog'));
    if (!worklog) return;
    var raw = Array.prototype.slice.call(worklog.querySelectorAll('.activity-thought-chunk'))
      .map(function (chunk) { return chunk.textContent || ''; })
      .join('\n\n')
      .trim();
    if (!raw) return;
    worklog.setAttribute('data-thinking-text', raw);
    worklog.classList.add('has-activity-thoughts');
    var label = worklog.querySelector('.activity-worklog-label');
    if (label) label.textContent = window.junctionT('thoughtTokens', 'Thought · ~{count} tokens', { count: window.approxTokens(raw).toLocaleString() });
  }
  window.updateActivityWorklogThoughtSummary = updateActivityWorklogThoughtSummary;

  function syncActivityLayoutForRow(row) {
    if (!row || !row.classList || !row.classList.contains('assistant')) return;
    var stream = ensureActivityStream(row);
    var reasoningSlot = row.querySelector('.reasoning-slot');
    var tools = row.querySelector('.tool-calls');
    var worklog = row.querySelector('.activity-worklog');
    if (!reasoningSlot) {
      reasoningSlot = document.createElement('div');
      reasoningSlot.className = 'reasoning-slot';
      stream.appendChild(reasoningSlot);
    }
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      stream.appendChild(tools);
    }

    if (activityUsesUnifiedTimeline()) {
      worklog = ensureWorklog(row);
      var body = worklog.querySelector('.activity-worklog-body');
      if (body && body.firstChild !== tools) body.appendChild(tools);
      if (stream.firstChild !== worklog) stream.insertBefore(worklog, stream.firstChild);
      if (reasoningSlot) {
        while (reasoningSlot.firstChild) tools.insertBefore(reasoningSlot.firstChild, tools.firstChild);
        reasoningSlot.remove();
      }
      var priorDuration = parseInt(row.getAttribute('data-work-duration-ms') || '0', 10);
      setWorklogState(row.getAttribute('data-run-id') || '', row.classList.contains('running') ? 'running' : 'done', priorDuration);
    } else {
      if (worklog) {
        var worklogBody = worklog.querySelector('.activity-worklog-body');
        if (worklogBody && tools.parentNode === worklogBody) stream.appendChild(tools);
        worklog.remove();
      }
      if (stream.firstChild !== reasoningSlot) stream.insertBefore(reasoningSlot, stream.firstChild);
      if (reasoningSlot.nextSibling !== tools) stream.insertBefore(tools, reasoningSlot.nextSibling);
    }
  }
  window.syncActivityLayoutForRow = syncActivityLayoutForRow;

  function syncActivityLayoutAllRows() {
    document.querySelectorAll('#chat-messages .chat-row.assistant').forEach(syncActivityLayoutForRow);
  }
  window.syncActivityLayoutAllRows = syncActivityLayoutAllRows;

  function ensureActivityNoteContainer(runId, row) {
    return ensureToolContainer(runId, row || ((runId && activeRuns.get(runId)) || document.querySelector('[data-run-id="' + runId + '"]')));
  }

  function updateActivityThoughtSummary(block) {
    if (!block) return;
    var raw = block.getAttribute('data-thinking-text') || '';
    var summary = block.querySelector(':scope > summary');
    var label = window.junctionT('thoughtTokens', 'Thought · ~{count} tokens', { count: window.approxTokens(raw).toLocaleString() });
    var labelEl = summary && summary.querySelector('.reasoning-label');
    if (labelEl) labelEl.textContent = label;
    else if (summary) summary.textContent = label;
  }
  window.updateActivityThoughtSummary = updateActivityThoughtSummary;

  function createActivityThoughtBlock() {
    var block = document.createElement('details');
    block.className = 'reasoning-disclosure activity-thought';
    block.setAttribute('data-activity-thought', 'true');
    block.setAttribute('data-thinking-text', '');
    block.open = true;

    var summary = document.createElement('summary');
    var label = window.junctionT('thoughtZeroTokens', 'Thought · ~0 tokens');
    if (window.summaryHtml) summary.innerHTML = window.summaryHtml(label, { showBar: false });
    else summary.textContent = label;
    block.appendChild(summary);
    summary.addEventListener('click', function (event) {
      var row = block.closest('.chat-row.assistant');
      if (!row || !activityUsesUnifiedTimeline()) return;
      event.preventDefault();
      var nextOpen = !block.open;
      row.querySelectorAll('.activity-thought').forEach(function (thought) {
        thought.open = nextOpen;
      });
    });
    updateActivityThoughtSummary(block);
    return block;
  }
  window.createActivityThoughtBlock = createActivityThoughtBlock;

  // Collapse intra-line whitespace but PRESERVE newlines. Thinking from most
  // bridges (hermes, opencode, openhands, openclaw, souveraine, mimocode) arrives
  // as multi-paragraph prose — numbered lists, blank-line breaks — and that
  // structure IS the readable shape. Goose is the one bridge that streams
  // fragmented token deltas, and it flattens its OWN thinking at the bridge layer
  // (goose/events.ts → normalizeThinkingText) before it ever reaches here, so it
  // has no newlines left to preserve. Stripping newlines in this shared renderer
  // applied Goose's flatten semantics to every bridge and mashed their reasoning
  // into one unreadable run-on blob. Keep bridge-specific normalization at the
  // bridge; here we only tidy whitespace.
  function normalizeThoughtBlobText(text) {
    return String(text || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function mergeThoughtBlobText(prior, next) {
    var left = normalizeThoughtBlobText(prior);
    var right = normalizeThoughtBlobText(next);
    if (!left) return right;
    if (!right) return left;
    // A single sentence split across deltas (prior ends with no terminator and
    // both sides land on an alphanumeric boundary) → glue with one space so the
    // sentence stays whole.
    if (!/[.!?…]["'`”’)\]]?$/.test(left)
        && /[A-Za-z0-9)'"`”’\]]$/.test(left)
        && /^[A-Za-z0-9('"`“‘\[]/.test(right)) {
      return left + ' ' + right;
    }
    // Otherwise these are distinct bursts/paragraphs — keep them separated.
    return left + '\n\n' + right;
  }
  window.mergeThoughtBlobText = mergeThoughtBlobText;

  function appendActivityThoughtText(block, text) {
    var raw = String(text || '').trim();
    if (!block || !raw) return;
    if (block.classList && block.classList.contains('tool-calls')) {
      var worklog = block.closest('.activity-worklog');
      var note = worklog && worklog.querySelector('.activity-thought-note[data-live-thought="true"]');
      var contentNode = note && note.querySelector('.activity-thought-chunk');
      if (!note || !contentNode) {
        note = document.createElement('div');
        note.className = 'activity-note activity-thought-note';
        note.setAttribute('data-live-thought', 'true');
        contentNode = document.createElement('div');
        contentNode.className = 'reasoning-content activity-thought-chunk';
        note.appendChild(contentNode);
        block.insertBefore(note, block.firstChild);
      }
      var nextText = mergeThoughtBlobText(contentNode.getAttribute('data-raw-thinking') || contentNode.textContent || '', raw);
      contentNode.setAttribute('data-raw-thinking', nextText);
      contentNode.innerHTML = window.formatThinkingContent ? window.formatThinkingContent(nextText) : window.renderMarkdown(nextText);
      updateActivityWorklogThoughtSummary(block.closest('.activity-worklog'));
      return;
    }
    var prior = block.getAttribute('data-thinking-text') || '';
    var merged = mergeThoughtBlobText(prior, raw);
    block.setAttribute('data-thinking-text', merged);
    var content = block.querySelector(':scope > .activity-thought-chunk');
    if (!content) {
      content = document.createElement('div');
      content.className = 'reasoning-content activity-thought-chunk';
      block.appendChild(content);
    }
    content.setAttribute('data-raw-thinking', merged);
    content.innerHTML = window.formatThinkingContent ? window.formatThinkingContent(merged) : window.renderMarkdown(merged);
    updateActivityThoughtSummary(block);
  }
  window.appendActivityThoughtText = appendActivityThoughtText;

  function dispatchActivityThoughtText(block, text) {
    var fn = window.appendActivityThoughtText || appendActivityThoughtText;
    return fn(block, text);
  }
  window.dispatchActivityThoughtText = dispatchActivityThoughtText;

  function ensureActivityThoughtBlock(runId, row) {
    var container = ensureActivityNoteContainer(runId, row);
    if (activityUsesUnifiedTimeline()) return container;
    var block = container.querySelector(':scope > .activity-thought[data-activity-thought="true"]');
    if (!block) {
      block = createActivityThoughtBlock();
      container.insertBefore(block, container.firstChild);
    }
    return block;
  }
  window.ensureActivityThoughtBlock = ensureActivityThoughtBlock;

  function appendActivityNotes(runId, deltaText, row) {
    if (!activityUsesUnifiedTimeline()) return;
    var delta = String(deltaText || '');
    if (!delta.trim()) return;
    var state = activityNoteState.get(runId) || { buffer: '' };
    state.buffer += delta;
    var parts = state.buffer.split(/\n\s*\n/);
    if (parts.length === 1) {
      if (state.buffer.length < 80 && !/[.!?]\s*$/.test(state.buffer)) {
        activityNoteState.set(runId, state);
        return;
      }
      parts = [state.buffer, ''];
    }
    state.buffer = parts.pop() || '';
    parts.map(function (part) { return String(part || '').trim(); }).filter(Boolean).forEach(function (part) {
      dispatchActivityThoughtText(ensureActivityThoughtBlock(runId, row), part);
    });
    activityNoteState.set(runId, state);
  }
  window.appendActivityNotes = appendActivityNotes;

  function flushActivityNotes(runId, row) {
    var state = activityNoteState.get(runId);
    if (!state || !state.buffer || !state.buffer.trim()) return;
    dispatchActivityThoughtText(ensureActivityThoughtBlock(runId, row), state.buffer.trim());
    state.buffer = '';
    activityNoteState.set(runId, state);
  }
  window.flushActivityNotes = flushActivityNotes;

  function appendHistoryActivityNote(runId, text, row) {
    var noteText = String(text || '').trim();
    if (!noteText) return;
    dispatchActivityThoughtText(ensureActivityThoughtBlock(runId, row), noteText);
  }
  window.appendHistoryActivityNote = appendHistoryActivityNote;

  function renderActivityTimelineHistory(row, item) {
    if (!row || !item || !item.activityTimeline || !item.activityTimeline.length) return;
    var runId = item.runId || row.getAttribute('data-run-id') || '';
    var toolsById = new Map();
    (item.tools || []).forEach(function (tool) {
      if (tool && tool.toolCallId) toolsById.set(tool.toolCallId, tool);
    });
    item.activityTimeline.forEach(function (entry) {
      if (!entry) return;
      if (entry.type === 'note' && entry.text) {
        appendHistoryActivityNote(runId, entry.text, row);
        return;
      }
      if (entry.type === 'tool' && entry.toolCallId && window.renderToolHistoryItem) {
        var tool = toolsById.get(entry.toolCallId);
        if (tool) {
          window.renderToolHistoryItem(row, tool);
          if (window.groupToolRows) window.groupToolRows(window.toolContainers.get(runId));
        }
      }
    });
    if (window.groupToolRows) window.groupToolRows(window.toolContainers.get(runId));
  }
  window.renderActivityTimelineHistory = renderActivityTimelineHistory;

  // Accordion-mode history replay: walk the ordered activityTimeline so thoughts
  // and tools rebuild in the same chronological intersperse as the live stream.
  // Reuses renderReasoning's segmentation by feeding cumulative thinking text and
  // raising the interrupt flag whenever a tool has intervened since the last note.
  function renderAccordionTimelineHistory(row, item) {
    if (!row || !item || !item.activityTimeline || !item.activityTimeline.length) return false;
    var runId = item.runId || row.getAttribute('data-run-id') || '';
    var toolsById = new Map();
    (item.tools || []).forEach(function (tool) {
      if (tool && tool.toolCallId) toolsById.set(tool.toolCallId, tool);
    });
    if (window.reasoningInterrupted) window.reasoningInterrupted.delete(runId);
    var running = '';
    var sawTool = false;
    var rendered = false;
    item.activityTimeline.forEach(function (entry) {
      if (!entry) return;
      if (entry.type === 'note' && entry.text) {
        if (sawTool && window.reasoningInterrupted) { window.reasoningInterrupted.add(runId); sawTool = false; }
        running = running ? (running + '\n\n' + String(entry.text)) : String(entry.text);
        window.renderReasoning(runId, running, { row: row, complete: true });
        rendered = true;
        return;
      }
      if (entry.type === 'tool' && entry.toolCallId && window.renderToolHistoryItem) {
        var tool = toolsById.get(entry.toolCallId);
        if (tool) { window.renderToolHistoryItem(row, tool); sawTool = true; rendered = true; }
      }
    });
    if (window.groupToolRows) window.groupToolRows(window.toolContainers.get(runId));
    return rendered;
  }
  window.renderAccordionTimelineHistory = renderAccordionTimelineHistory;

  // ── Share / export helpers ────────────────────────────────────────────────
  function escapeExportText(value) {
    return String(value || '').replace(/</g, '&lt;');
  }

  function buildChatExportHtml() {
    var rows = document.querySelectorAll('#chat-messages .chat-row');
    var cs = getComputedStyle(document.body);
    var bg = cs.backgroundColor || 'Canvas';
    var fg = cs.color || 'CanvasText';
    var font = cs.fontFamily || 'monospace';
    var fontSize = cs.fontSize || '13px';
    var root = document.documentElement;
    var rcs = getComputedStyle(root);
    function cv(n, fb) { return rcs.getPropertyValue(n).trim() || fb; }
    var userBg = cv('--vscode-sideBar-background', bg);
    var userFg = cv('--vscode-editor-foreground', fg);
    var inputBorder = cv('--vscode-input-border', 'transparent');
    var focusBorder = cv('--vscode-focusBorder', fg);
    var descFg = cv('--vscode-descriptionForeground', fg);
    var codeBg = cv('--vscode-textCodeBlock-background', 'transparent');
    var toolBg = cv('--vscode-editor-background', bg);
    var toolBorder = cv('--vscode-widget-border', inputBorder);
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chat Export</title><style>body{background:' + bg + ';color:' + fg + ';font-family:' + font + ';font-size:' + fontSize + ';padding:20px;max-width:800px;margin:0 auto;line-height:1.6;}h1{color:' + fg + ';border-bottom:1px solid ' + inputBorder + ';padding-bottom:8px;}.meta{color:' + descFg + ';font-size:0.8em;margin-bottom:16px;}.msg{margin-bottom:16px;padding:10px 14px;border-radius:6px;border:1px solid transparent;}.msg.user{background:' + userBg + ';color:' + userFg + ';}.msg.assistant{background:' + toolBg + ';}.role{font-weight:600;margin-bottom:4px;font-size:0.85em;color:' + descFg + ';}.msg.user .role,.msg.assistant .role{color:' + focusBorder + ';}.text{white-space:pre-wrap;word-break:break-word;}.tool{margin:8px 0;padding:8px 10px;background:' + codeBg + ';border:1px solid ' + toolBorder + ';border-radius:4px;font-family:' + font + ';font-size:0.85em;color:' + descFg + ';}.tool-name{color:' + focusBorder + ';font-weight:600;margin-bottom:4px;}.thinking{margin:8px 0;padding:8px 10px;border-left:2px solid ' + focusBorder + ';color:' + descFg + ';font-size:0.85em;font-style:italic;}</style></head><body><h1>Chat Export</h1><p class="meta">' + new Date().toLocaleString() + '</p>';

    rows.forEach(function (r) {
      var isUser = r.classList.contains('user');
      var isAssistant = r.classList.contains('assistant');
      if (!isUser && !isAssistant) return;
      var rRole = isUser ? 'You' : 'Assistant';
      var reasoning = r.querySelector('.reasoning-disclosure');
      if (reasoning) {
        var thinkContent = reasoning.querySelector('.reasoning-content');
        var thinkLabel = reasoning.querySelector('.reasoning-label');
        if (thinkContent && thinkContent.textContent.trim()) {
          html += '<div class="thinking">';
          if (thinkLabel) html += '<strong>' + escapeExportText(thinkLabel.textContent.trim()) + '</strong><br>';
          html += escapeExportText(thinkContent.textContent.trim());
          html += '</div>';
        }
      }
      r.querySelectorAll('.tool-row').forEach(function (card) {
        var toolName = card.querySelector('.tool-name, .tool-row-name, .tool-verb');
        var toolResult = card.querySelector('.tool-result, .tool-row-body, .tool-detail');
        html += '<div class="tool">';
        if (toolName) html += '<div class="tool-name">' + escapeExportText(toolName.textContent.trim()) + '</div>';
        if (toolResult) html += '<div>' + escapeExportText(toolResult.textContent.trim()) + '</div>';
        html += '</div>';
      });
      var textEl = r.querySelector('.msg-text');
      if (textEl) {
        var rawText = textEl.dataset.rawText || textEl.textContent || '';
        var trimmed = rawText.trim();
        if (!trimmed) return;
        html += '<div class="msg ' + (isUser ? 'user' : 'assistant') + '"><div class="role">' + rRole + '</div><div class="text">' + escapeExportText(trimmed) + '</div></div>';
      }
    });
    return html + '</body></html>';
  }

  function downloadChatExportHtml() {
    var blob = new Blob([buildChatExportHtml()], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chat-export-' + Date.now() + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function copyViaHost(text) {
    vscode.postMessage({ type: 'copyToClipboard', text: String(text || '') });
  }

  function findMessageRow(messageId) {
    if (!messageId) return null;
    var rows = document.querySelectorAll('#chat-messages .chat-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-message-id') === messageId || rows[i].getAttribute('data-run-id') === messageId) {
        return rows[i];
      }
    }
    return null;
  }

  function getActionRow(bar, messageId) {
    return (bar && bar.closest && bar.closest('.chat-row')) || findMessageRow(messageId);
  }

  function getRowCopyText(row) {
    if (!row) return '';
    var bubble = row.querySelector('.msg-text');
    var text = bubble ? String(bubble.dataset.rawText || bubble.textContent || '').trim() : '';
    if (text) return text;
    var activity = row.querySelector('.assistant-activity');
    text = activity ? String(activity.textContent || '').trim() : '';
    if (text) return text;
    return String(row.textContent || '').trim();
  }

  function forkMessage(messageId) {
    window.showForkOverlay();
    vscode.postMessage({ type: 'forkConversation', messageId: messageId });
  }

  function openForkMenu(row, triggerBtn, messageId, hasCheckpoint) {
    if (!window.choiceMenu) {
      forkMessage(messageId);
      return;
    }
    var items = [
      { id: 'fork', label: window.junctionT('fork', 'Fork'), icon: 'git-branch', action: function () { forkMessage(messageId); } },
    ];
    window.choiceMenu.open(triggerBtn || row, {
      title: window.junctionT('fork', 'Fork'),
      items: items,
      placement: row && document.body.classList.contains('stream-layout-timeline') ? 'above' : undefined,
    });
  }

  // ── Share popover ─────────────────────────────────────────────────────────
  /** Gather all messages up to and including the given row. */
  function getHistoryUpToRow(targetRow) {
    var msgs = [];
    var rows = document.querySelectorAll('#chat-messages .chat-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var isUser = r.classList.contains('user');
      var isAssistant = r.classList.contains('assistant');
      if (!isUser && !isAssistant) continue;
      var text = r.querySelector('.msg-text');
      if (text) msgs.push({ role: isUser ? 'user' : 'assistant', text: (text.dataset.rawText || text.textContent || '').trim() });
      if (r === targetRow) break;
    }
    return msgs;
  }

  function formatMessagesMarkdown(msgs) {
    return msgs.map(function (m) {
      var label = m.role === 'user' ? window.junctionT('you', 'You') : window.junctionT('assistant', 'Assistant');
      return '**' + label + ':** ' + m.text;
    }).join('\n\n');
  }

  function formatMessagesText(msgs) {
    return msgs.map(function (m) {
      var label = m.role === 'user' ? window.junctionT('you', 'You') : window.junctionT('assistant', 'Assistant');
      return label + ': ' + m.text;
    }).join('\n\n');
  }

  /** Share menu: ENTIRE history up to this post, plus copy single post as Markdown. */
  function openShareForRow(row, triggerBtn) {
    if (!row) return;
    var text = getRowCopyText(row);
    var role = row.classList.contains('user') ? window.junctionT('you', 'You') : window.junctionT('assistant', 'Assistant');
    var trigger = triggerBtn || row;
    if (!window.choiceMenu) return;
    var items = [
      { id: 'single-md', label: window.junctionT('copyAsMarkdown', 'Copy as Markdown'), icon: 'markdown', action: function () { copyViaHost('**' + role + ':** ' + text); } },
      { id: 'separator', separator: true },
      { id: 'markdown', label: window.junctionT('copyHistoryAsMarkdown', 'Copy history as Markdown'), icon: 'markdown', action: function () { copyViaHost(formatMessagesMarkdown(getHistoryUpToRow(row))); } },
      { id: 'text', label: window.junctionT('copyHistoryAsText', 'Copy history as Text'), icon: 'clipboard', action: function () { copyViaHost(formatMessagesText(getHistoryUpToRow(row))); } },
      { id: 'html', label: window.junctionT('exportHtml', 'Export HTML'), icon: 'file', action: downloadChatExportHtml },
    ];
    window.choiceMenu.open(trigger, {
      title: window.junctionT('shareHistory', 'Share'),
      items: items,
      placement: row && document.body.classList.contains('stream-layout-timeline') ? 'above' : undefined,
    });
  }

  /** Copy menu: just copies this ONE post as plain text. */
  function openCopyForRow(row, triggerBtn) {
    if (!row) return;
    var text = getRowCopyText(row);
    copyViaHost(text);
    if (triggerBtn) {
      triggerBtn.classList.remove('codicon-copy');
      triggerBtn.classList.add('codicon-check');
      setTimeout(function () { triggerBtn.classList.remove('codicon-check'); triggerBtn.classList.add('codicon-copy'); }, 1500);
    }
  }

  // ── Message actions bar ──────────────────────────────────────────────────
  window.betaForkRewind = false;

  function buildMsgActions(messageId, isAssistant, hasCheckpoint) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    var row = findMessageRow(messageId);
    var actions = [
      { icon: 'copy', label: window.junctionT('copy', 'Copy'), act: 'copy' },
      { icon: 'clippy', label: window.junctionT('share', 'Share'), act: 'share' },
      { icon: 'git-branch', label: window.junctionT('fork', 'Fork'), act: 'fork' },
    ];
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'msg-action codicon codicon-' + a.icon;
      b.title = a.label;
      b.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (a.act === 'copy') { openCopyForRow(getActionRow(bar, messageId), b); }
        else if (a.act === 'share') { openShareForRow(getActionRow(bar, messageId), b); }
        else if (a.act === 'fork') {
          openForkMenu(getActionRow(bar, messageId), b, messageId, false);
        }
      });
      bar.appendChild(b);
    });

    if (isAssistant && messageId && window.messageReactionsEnabled === true) {
      var row = findMessageRow(messageId);
      var currentReaction = row ? row.getAttribute('data-reaction') : null;
      var pair = window.getReactionPair();
      var reactions = [
        { type: 'down', glyph: pair.down, label: window.junctionT('badResponse', 'Bad response') },
        { type: 'up', glyph: pair.up, label: window.junctionT('goodResponse', 'Good response') }
      ];
      reactions.forEach(function (r) {
        var b = document.createElement('button');
        b.className = 'msg-action';
        if (r.glyph.indexOf('codicon:') === 0) { b.classList.add('codicon', 'codicon-' + r.glyph.slice(8)); }
        else { if (r.glyph.length > 2) b.classList.add('text-reaction'); b.textContent = r.glyph; }
        b.title = r.label;
        if (currentReaction === r.type) b.classList.add('active');
        b.addEventListener('click', function () {
          var parent = bar.parentElement;
          var old = parent ? parent.getAttribute('data-reaction') : null;
          var newVal = (old === r.type) ? null : r.type;
          if (parent) { if (newVal) parent.setAttribute('data-reaction', newVal); else parent.removeAttribute('data-reaction'); }
          bar.querySelectorAll('.msg-action').forEach(function (btn) {
            if (btn.title === window.junctionT('goodResponse', 'Good response') || btn.title === window.junctionT('badResponse', 'Bad response')) btn.classList.remove('active');
          });
          if (newVal === r.type) b.classList.add('active');
          vscode.postMessage({ type: 'setReaction', messageId: messageId, value: newVal });
        });
        bar.appendChild(b);
      });
    }
    return bar;
  }
  window.buildMsgActions = buildMsgActions;

  // ── User row ──────────────────────────────────────────────────────────────
  function addUserRow(text, messageId, hasCheckpoint, insertTarget, isSteer) {
    if (isWorkspaceContext(text)) return null;
    var row = document.createElement('div');
    row.className = 'chat-row user';
    if (String(text || '').trim()) row.classList.add('timeline-sticky-user');
    if (!window.isRestoringHistory) row.classList.add('rise-up-anim');
    if (messageId) row.setAttribute('data-message-id', messageId);
    if (hasCheckpoint) row.setAttribute('data-has-checkpoint', 'true');
    if (isSteer) row.setAttribute('data-steer', 'true');

    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    var tipVal = getComputedStyle(document.documentElement).getPropertyValue('--junction-bubble-tip').trim();
    if (tipVal && tipVal !== 'none') bubble.setAttribute('data-tip', tipVal);
    bubble.dataset.rawText = text;
    bubble.innerHTML = window.renderMarkdown(text);
    row.appendChild(bubble);

    // Sticky user row truncation: clamp, then check if overflowed.
    // Dev/beta-gated behind MASTER_DEBUG — unfinished in compact/accordion layout.
    if (window.MASTER_DEBUG && row.classList.contains('timeline-sticky-user')) {
      bubble.classList.add('is-clamped');
      setTimeout(function () {
        if (bubble.scrollHeight <= bubble.offsetHeight + 4) {
          bubble.classList.remove('is-clamped');
          return;
        }
        var showMore = document.createElement('button');
        showMore.className = 'sticky-show-more';
        showMore.textContent = window.junctionT('showMore', 'Show more');
        showMore.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var isClamped = bubble.classList.toggle('is-clamped');
          showMore.textContent = isClamped
            ? window.junctionT('showMore', 'Show more')
            : window.junctionT('showLess', 'Show less');
        });
        row.appendChild(showMore);
      }, 0);
    }

    if (isSteer) {
      var steerBadge = document.createElement('span');
      steerBadge.className = 'steer-badge';
      steerBadge.textContent = window.junctionT('steer', 'STEER');
      bubble.insertBefore(steerBadge, bubble.firstChild);
    }

    row.appendChild(buildMsgActions(messageId, false, hasCheckpoint));

    var mDiv = document.getElementById('chat-messages');
    if (window.historyFragment) {
      window.historyFragment.appendChild(row);
    } else if (insertTarget && insertTarget.parentNode === mDiv) {
      mDiv.insertBefore(row, insertTarget);
    } else if (window.workingRow && window.workingRow.parentNode === mDiv) {
      mDiv.insertBefore(row, window.workingRow);
    } else if (pinnedThrobber_m && pinnedThrobber_m.parentNode === mDiv) {
      mDiv.insertBefore(row, pinnedThrobber_m);
    } else {
      mDiv.appendChild(row);
    }
    if (!window.isRestoringHistory) window.scrollToBottom();
    return row;
  }
  window.addUserRow = addUserRow;

  // ── Assistant row builder ──────────────────────────────────────────────────
  function buildAssistantRow(runId, track, insertTarget) {
    var row = document.createElement('div');
    row.className = 'chat-row assistant';
    if (track) row.classList.add('running');
    if (!window.isRestoringHistory) row.classList.add('rise-up-anim');
    if (runId) row.setAttribute('data-run-id', runId);
    row.setAttribute('data-run-start-ms', String(Date.now()));

    var activity = document.createElement('div');
    activity.className = 'assistant-activity';
    row.appendChild(activity);

    var reasoning = document.createElement('div');
    reasoning.className = 'reasoning-slot';
    activity.appendChild(reasoning);

    var tools = document.createElement('div');
    tools.className = 'tool-calls';
    activity.appendChild(tools);
    if (runId) window.toolContainers.set(runId, tools);
    syncActivityLayoutForRow(row);

    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    row.appendChild(bubble);

    var mDiv = document.getElementById('chat-messages');
    if (window.historyFragment) {
      window.historyFragment.appendChild(row);
    } else if (insertTarget && insertTarget.parentNode === mDiv) {
      mDiv.insertBefore(row, insertTarget);
    } else if (window.workingRow && window.workingRow.parentNode === mDiv) {
      mDiv.insertBefore(row, window.workingRow);
    } else if (pinnedThrobber_m && pinnedThrobber_m.parentNode === mDiv) {
      mDiv.insertBefore(row, pinnedThrobber_m);
    } else {
      mDiv.appendChild(row);
    }
    if (track && runId) window.activeRuns.set(runId, row);
    if (runId) activityTextState.set(runId, '');
    if (runId) thinkingTextState.set(runId, '');
    return row;
  }
  window.buildAssistantRow = buildAssistantRow;

  // ── History assistant row ──────────────────────────────────────────────────
  function addAssistantHistoryRow(item, index, insertTarget) {
    var runId = item.runId || 'history:' + index;
    var mDiv = document.getElementById('chat-messages');
    var isActiveRun = item.runId && (mDiv.dataset.activeRun === item.runId || !item.thinkingComplete);
    try {
      var row = buildAssistantRow(runId, isActiveRun, insertTarget);
      if (item.messageId) row.setAttribute('data-message-id', item.messageId);
      if (item.hasCheckpoint) row.setAttribute('data-has-checkpoint', 'true');
      if (item.reaction) row.setAttribute('data-reaction', item.reaction);
      var bubble = row.querySelector('.msg-text');
      var hasTimeline = item.activityTimeline && item.activityTimeline.length;
      var useUnifiedHistoryTimeline = activityUsesUnifiedTimeline() && hasTimeline;
      var useAccordionHistoryTimeline = !useUnifiedHistoryTimeline && hasTimeline;
      bubble.dataset.rawText = item.content || '';
      bubble.innerHTML = window.renderMarkdown(item.content || '');
      if (useUnifiedHistoryTimeline) {
        renderActivityTimelineHistory(row, item);
      } else if (useAccordionHistoryTimeline) {
        renderAccordionTimelineHistory(row, item);
      } else if (item.thinking) {
        window.renderReasoning(runId, item.thinking, { row: row, complete: !!item.thinkingComplete, durationMs: item.thinkingDurationMs });
      }
      if (!useUnifiedHistoryTimeline && !useAccordionHistoryTimeline && item.tools && item.tools.length) {
        window.renderToolHistory(row, item.tools);
      }
      row.appendChild(buildMsgActions(item.messageId || runId, true, item.hasCheckpoint));
      return row;
    } catch (e) {
      console.error('addAssistantHistoryRow failed:', e);
      return null;
    }
  }
  window.addAssistantHistoryRow = addAssistantHistoryRow;

  // ── getOrCreateAssistantMessage ─────────────────────────────────────────
  function getOrCreateAssistantMessage(runId) {
    if (window.activeRuns.has(runId)) return window.activeRuns.get(runId);
    var info = window.runSubagentInfo.get(runId);
    var row = buildAssistantRow(runId, true);
    if (info) row.classList.add(info.spawnDepth > 2 ? 'subagent-deep' : 'subagent');
    if (info) applySubagentLabel(row, info);
    window.scrollToBottom();
    return row;
  }
  window.getOrCreateAssistantMessage = getOrCreateAssistantMessage;

  // ── setAssistantText ──────────────────────────────────────────────────────
  function setAssistantText(runId, fullText) {
    if (isWorkspaceContext(fullText)) return;
    var row = getOrCreateAssistantMessage(runId);
    var text = row.querySelector('.msg-text');
    if (!text) return;

    activityTextState.set(runId, String(fullText || ''));

    text.dataset.rawText = fullText;
    text.innerHTML = window.renderMarkdown(fullText || '');
    ensureToolContainer(runId, row);
    window.scrollToBottom();
  }
  window.setAssistantText = setAssistantText;

  function renderCommandOutputBlock(block) {
    if (!block || !block.type) return '';
    if (block.type === 'text') return '<div class="command-output-text">' + window.renderMarkdown(block.text || '') + '</div>';
    if (block.type === 'error') {
      return '<div class="command-output-error">' +
        (block.title ? '<div class="command-output-block-title">' + window.escapeHtml(block.title) + '</div>' : '') +
        '<pre>' + window.escapeHtml(block.text || '') + '</pre>' +
      '</div>';
    }
    if (block.type === 'keyValue') {
      var kv = (block.rows || []).map(function (row) {
        return '<div class="command-output-kv-row"><dt>' + window.escapeHtml(row.key || '') + '</dt><dd>' + window.escapeHtml(row.value || '') + '</dd></div>';
      }).join('');
      return '<section class="command-output-block">' +
        (block.title ? '<div class="command-output-block-title">' + window.escapeHtml(block.title) + '</div>' : '') +
        '<dl class="command-output-kv">' + kv + '</dl>' +
      '</section>';
    }
    if (block.type === 'table') {
      var cols = block.columns || [];
      var head = '<thead><tr>' + cols.map(function (col) { return '<th>' + window.escapeHtml(col || '') + '</th>'; }).join('') + '</tr></thead>';
      var body = '<tbody>' + (block.rows || []).map(function (row) {
        return '<tr>' + cols.map(function (_, i) { return '<td>' + window.escapeHtml((row || [])[i] || '') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<section class="command-output-block">' +
        (block.title ? '<div class="command-output-block-title">' + window.escapeHtml(block.title) + '</div>' : '') +
        '<div class="command-output-table-wrap"><table class="command-output-table">' + head + body + '</table></div>' +
      '</section>';
    }
    if (block.type === 'sections') {
      return '<section class="command-output-block">' +
        (block.title ? '<div class="command-output-block-title">' + window.escapeHtml(block.title) + '</div>' : '') +
        (block.sections || []).map(function (section) {
          return '<div class="command-output-section"><div class="command-output-section-title">' + window.escapeHtml(section.title || '') + '</div>' +
            (section.text ? '<div class="command-output-text">' + window.renderMarkdown(section.text || '') + '</div>' : '') +
            (section.rows ? renderCommandOutputBlock({ type: 'keyValue', rows: section.rows }) : '') +
          '</div>';
        }).join('') +
      '</section>';
    }
    return '';
  }

  function setAssistantCommandOutput(runId, payload, fallbackText) {
    var row = getOrCreateAssistantMessage(runId);
    var text = row.querySelector('.msg-text');
    if (!text) return;
    var raw = String(fallbackText || '');
    activityTextState.set(runId, raw);
    text.dataset.rawText = raw;
    var blocks = payload && Array.isArray(payload.blocks) ? payload.blocks : [];
    var title = payload && (payload.title || payload.command);
    text.innerHTML = '<div class="command-output">' +
      (title ? '<div class="command-output-title">' + window.escapeHtml(title) + '</div>' : '') +
      blocks.map(renderCommandOutputBlock).join('') +
    '</div>';
    ensureToolContainer(runId, row);
    window.scrollToBottom();
  }
  window.setAssistantCommandOutput = setAssistantCommandOutput;

  // ── Tool container helpers ────────────────────────────────────────────────
  function ensureToolContainer(runId, row) {
    var tools = row.querySelector('.tool-calls');
    if (!tools) {
      var stream = ensureActivityStream(row);
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      stream.appendChild(tools);
    }
    window.toolContainers.set(runId, tools);
    return tools;
  }

  // ── Fork overlay ──────────────────────────────────────────────────────────
  function showForkOverlay() {
    var existing = document.getElementById('fork-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'fork-overlay';

    var clonedContainer = document.createElement('div');
    clonedContainer.className = 'fork-cloned-messages';
    var mDiv = document.getElementById('chat-messages');
    Array.prototype.forEach.call(mDiv.children, function(child) {
      if (child.id === 'pinned-anim-throbber') return;
      clonedContainer.appendChild(child.cloneNode(true));
    });
    overlay.appendChild(clonedContainer);

    var card = document.createElement('div');
    card.className = 'fork-bobber-card';

    var textEl = document.createElement('div');
    textEl.className = 'fork-bobber-text';
    textEl.textContent = window.junctionT('forkingConversation', 'Forking conversation...');

    card.appendChild(textEl);
    overlay.appendChild(card);

    var chatView = document.getElementById('chat-view');
    if (chatView) {
      chatView.appendChild(overlay);
      clonedContainer.scrollTop = mDiv.scrollTop;
    }
  }
  window.showForkOverlay = showForkOverlay;

  function hideForkOverlay() {
    var overlay = document.getElementById('fork-overlay');
    if (overlay) {
      overlay.remove();
    }
  }
  window.hideForkOverlay = hideForkOverlay;

  // ── Share/export chat ────────────────────────────────────────────────────
  function openShareMenu(trigger) {
    var anchor = trigger || document.getElementById('btn-menu') || document.body;
    function getMessages() {
      var msgs = [];
      document.querySelectorAll('#chat-messages .chat-row').forEach(function (row) {
        var isUser = row.classList.contains('user');
        var text = row.querySelector('.msg-text');
        if (text) msgs.push({ role: isUser ? 'user' : 'assistant', text: (text.dataset.rawText || text.textContent || '').trim() });
      });
      return msgs;
    }
    if (!window.choiceMenu) return;
    window.choiceMenu.open(anchor, {
      title: window.junctionT('shareChat', 'Share chat'),
      items: [
        { id: 'markdown', label: window.junctionT('copyAsMarkdown', 'Copy as Markdown'), icon: 'markdown', action: function () {
          var md = getMessages().map(function (m) { return (m.role === 'user' ? '**' + window.junctionT('you', 'You') + ':** ' : '**' + window.junctionT('assistant', 'Assistant') + ':** ') + m.text; }).join('\n\n');
          copyViaHost(md);
        } },
        { id: 'text', label: window.junctionT('copyAsText', 'Copy as Text'), icon: 'clipboard', action: function () {
          var txt = getMessages().map(function (m) { return (m.role === 'user' ? window.junctionT('you', 'You') + ': ' : window.junctionT('assistant', 'Assistant') + ': ') + m.text; }).join('\n\n');
          copyViaHost(txt);
        } },
        { id: 'html', label: window.junctionT('exportHtml', 'Export HTML'), icon: 'file', action: downloadChatExportHtml },
      ],
    });
  }
  window.openShareMenu = openShareMenu;

})();
