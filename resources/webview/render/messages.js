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
    if (state === 'done') {
      worklog.classList.remove('thinking');
      var started = parseInt(row.getAttribute('data-run-start-ms') || '0', 10);
      var elapsed = durationMs || (started ? (Date.now() - started) : 0);
      row.setAttribute('data-work-duration-ms', String(elapsed));
      label.textContent = 'Worked for ' + formatWorkedDuration(elapsed);
    } else {
      worklog.classList.add('thinking');
      label.textContent = 'Working...';
    }
  }
  window.setWorklogState = setWorklogState;

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
    var label = 'Thought · ~' + window.approxTokens(raw).toLocaleString() + ' tokens';
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
    var label = 'Thought · ~0 tokens';
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

  function appendActivityThoughtText(block, text) {
    var raw = String(text || '').trim();
    if (!block || !raw) return;
    var prior = block.getAttribute('data-thinking-text') || '';
    block.setAttribute('data-thinking-text', [prior, raw].filter(Boolean).join('\n\n'));
    var content = document.createElement('div');
    content.className = 'reasoning-content activity-thought-chunk';
    content.innerHTML = window.formatThinkingContent ? window.formatThinkingContent(raw) : window.renderMarkdown(raw);
    block.appendChild(content);
    updateActivityThoughtSummary(block);
  }
  window.appendActivityThoughtText = appendActivityThoughtText;

  function ensureActivityThoughtBlock(runId, row) {
    var container = ensureActivityNoteContainer(runId, row);
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
      appendActivityThoughtText(ensureActivityThoughtBlock(runId, row), part);
    });
    activityNoteState.set(runId, state);
  }
  window.appendActivityNotes = appendActivityNotes;

  function flushActivityNotes(runId, row) {
    var state = activityNoteState.get(runId);
    if (!state || !state.buffer || !state.buffer.trim()) return;
    appendActivityThoughtText(ensureActivityThoughtBlock(runId, row), state.buffer.trim());
    state.buffer = '';
    activityNoteState.set(runId, state);
  }
  window.flushActivityNotes = flushActivityNotes;

  function appendHistoryActivityNote(runId, text, row) {
    var noteText = String(text || '').trim();
    if (!noteText) return;
    appendActivityThoughtText(ensureActivityThoughtBlock(runId, row), noteText);
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

  // ── Share popover ─────────────────────────────────────────────────────────
  function openShareForRow(row, triggerBtn) {
    if (!row) return;
    var bubble = row.querySelector('.msg-text');
    var text = bubble ? (bubble.dataset.rawText || bubble.textContent || '') : '';
    var role = row.classList.contains('user') ? 'You' : 'Assistant';
    var trigger = triggerBtn || row;
    if (!window.choiceMenu) return;
    window.choiceMenu.open(trigger, {
      title: 'Share message',
      items: [
        { id: 'markdown', label: 'Copy as Markdown', icon: 'markdown', action: function () { copyViaHost('**' + role + ':** ' + text); } },
        { id: 'text', label: 'Copy as Text', icon: 'clipboard', action: function () { copyViaHost(text); } },
        { id: 'html', label: 'Export HTML', icon: 'file', action: downloadChatExportHtml },
      ],
    });
  }

  // ── Message actions bar ──────────────────────────────────────────────────
  window.betaForkRewind = false;

  function buildMsgActions(messageId, isAssistant, hasCheckpoint) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    var actions = [
      { icon: 'copy', label: 'Copy', act: 'copy' },
      { icon: 'clippy', label: 'Share', act: 'share' },
    ];
    if (window.betaForkRewind) {
      actions.push({ icon: 'git-branch', label: 'Fork conversation (OpenClaw beta)', act: 'fork' });
      if (!isAssistant && hasCheckpoint) {
        actions.push({ icon: 'history', label: 'Rewind code to here (OpenClaw beta)', act: 'rewind' });
      }
    }
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'msg-action codicon codicon-' + a.icon;
      b.title = a.label;
      b.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (a.act === 'copy') {
          var row = bar.parentElement;
          var t = row && row.querySelector('.msg-text');
          if (t) {
            var textToCopy = t.dataset.rawText || t.textContent || '';
            copyViaHost(textToCopy);
            b.classList.remove('codicon-copy');
            b.classList.add('codicon-check');
            setTimeout(function () { b.classList.remove('codicon-check'); b.classList.add('codicon-copy'); }, 1500);
          }
        } else if (a.act === 'share') { openShareForRow(bar.parentElement, b); }
        else if (a.act === 'fork') {
          window.showForkOverlay();
          vscode.postMessage({ type: 'forkConversation', messageId: messageId });
        } else if (a.act === 'rewind') {
          vscode.postMessage({ type: 'rewindToMessage', messageId: messageId });
        }
      });
      bar.appendChild(b);
    });

    if (isAssistant && messageId) {
      var row = document.querySelector('[data-message-id="' + messageId + '"]') ||
                document.querySelector('[data-run-id="' + messageId + '"]');
      var currentReaction = row ? row.getAttribute('data-reaction') : null;
      var pair = window.getReactionPair();
      var reactions = [
        { type: 'down', glyph: pair.down, label: 'Bad response' },
        { type: 'up', glyph: pair.up, label: 'Good response' }
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
            if (btn.title === 'Good response' || btn.title === 'Bad response') btn.classList.remove('active');
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

    if (isSteer) {
      var steerBadge = document.createElement('span');
      steerBadge.className = 'steer-badge';
      steerBadge.textContent = 'STEER';
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
    if (!window.isRestoringHistory) window.forceScrollToBottom();
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

    var canvasContainer = document.createElement('div');
    canvasContainer.style.width = '160px';
    canvasContainer.style.height = '40px';
    canvasContainer.style.display = 'flex';
    canvasContainer.style.alignItems = 'center';
    canvasContainer.style.justifyContent = 'center';

    var canvas = window.createAnimatedCanvas('Forking', { loader: true, width: 160, height: 40, loaderLoop: true });
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvasContainer.appendChild(canvas);
      card._loaderCanvas = canvas;
    }

    var textEl = document.createElement('div');
    textEl.className = 'fork-bobber-text';
    textEl.textContent = 'Forking conversation...';

    card.appendChild(canvasContainer);
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
      var card = overlay.querySelector('.fork-bobber-card');
      if (card && card._loaderCanvas && typeof card._loaderCanvas._stopAnimation === 'function') {
        try { card._loaderCanvas._stopAnimation(); } catch (e) {}
      }
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
      title: 'Share chat',
      items: [
        { id: 'markdown', label: 'Copy as Markdown', icon: 'markdown', action: function () {
          var md = getMessages().map(function (m) { return (m.role === 'user' ? '**You:** ' : '**Assistant:** ') + m.text; }).join('\n\n');
          copyViaHost(md);
        } },
        { id: 'text', label: 'Copy as Text', icon: 'clipboard', action: function () {
          var txt = getMessages().map(function (m) { return (m.role === 'user' ? 'You: ' : 'Assistant: ') + m.text; }).join('\n\n');
          copyViaHost(txt);
        } },
        { id: 'html', label: 'Export HTML', icon: 'file', action: downloadChatExportHtml },
      ],
    });
  }
  window.openShareMenu = openShareMenu;

})();
