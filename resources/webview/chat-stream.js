/* ==========================================================================
   chat-stream.js — Message stream renderer (the chat transcript)
   ==========================================================================
   Owns #chat-messages. Renders user/assistant rows, inline reasoning
   disclosures (stream expanded, auto-collapse on finish), tool-call cards,
   subagent labels, token footers, and per-message actions.

   Globals exposed for other modules:
     window.renderHistory(history)              — repaint transcript (view-router)
     window.getOrCreateAssistantMessage(runId)  — assistant row (compat)

   Inbound messages handled:
     history · userEcho · response · assistant_stream_start/delta/end ·
     thinking_chunk · thinking_end · tool_start · tool_update · tool_result ·
     subagentInfo · tokenUsage
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;

  // ── Markdown ──────────────────────────────────────────────────────────────
  var md = { render: function (t) { return escapeHtml(t).replace(/\n/g, '<br>'); } };
  if (window.markdownit) {
    md = window.markdownit({ html: false, linkify: true, breaks: true });
  }
  function renderMarkdown(text) {
    try { return md.render(text || ''); } catch (e) { return escapeHtml(text || ''); }
  }
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function scrollToBottom() { messagesDiv.scrollTop = messagesDiv.scrollHeight; }

  // ── State ───────────────────────────────────────────────────────────────
  var activeRuns = new Map();        // runId → assistant row element
  var runSubagentInfo = new Map();   // runId → subagent metadata
  var reasoningBlocks = new Map();   // runId → <details> element
  var toolCalls = new Map();         // toolCallId → tool card element
  var toolContainers = new Map();    // runId → .tool-calls container

  // ── User rows + per-message actions ────────────────────────────────────────
  function addUserRow(text, messageId, hasCheckpoint) {
    var row = document.createElement('div');
    row.className = 'chat-row user';
    if (messageId) row.setAttribute('data-message-id', messageId);

    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    bubble.innerHTML = renderMarkdown(text);
    row.appendChild(bubble);

    if (messageId) row.appendChild(buildCheckpointMarker(messageId, hasCheckpoint));
    row.appendChild(buildMsgActions(messageId));
    messagesDiv.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addAssistantHistoryRow(text) {
    var row = document.createElement('div');
    row.className = 'chat-row assistant';
    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    bubble.innerHTML = renderMarkdown(text);
    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    return row;
  }

  function buildCheckpointMarker(messageId, hasCheckpoint) {
    var marker = document.createElement('span');
    marker.className = 'checkpoint-marker' + (hasCheckpoint ? ' available' : '');
    marker.title = hasCheckpoint ? 'Checkpoint available' : 'Checkpoint pending';
    marker.dataset.messageId = messageId;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

  function buildMsgActions(messageId) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    var actions = [
      { icon: 'copy', label: 'Copy', act: 'copy' },
      { icon: 'history', label: 'Rewind code to here', act: 'rewind' },
      { icon: 'git-branch', label: 'Fork conversation', act: 'fork' },
      { icon: 'discard', label: 'Fork and rewind code to here', act: 'forkRewind' },
    ];
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'msg-action codicon codicon-' + a.icon;
      b.title = a.label;
      b.addEventListener('click', function () {
        if (a.act === 'copy') {
          var row = bar.parentElement;
          var t = row && row.querySelector('.msg-text');
          if (t) { try { navigator.clipboard.writeText(t.textContent || ''); } catch (e) {} }
        } else if (a.act === 'fork') {
          vscode.postMessage({ type: 'forkConversation', messageId: messageId });
        } else if (a.act === 'rewind') {
          vscode.postMessage({ type: 'rewindCode', messageId: messageId, fork: false });
        } else if (a.act === 'forkRewind') {
          vscode.postMessage({ type: 'rewindCode', messageId: messageId, fork: true });
        }
      });
      bar.appendChild(b);
    });
    return bar;
  }

  // ── Assistant rows (text + tool-call container) ─────────────────────────────
  function getOrCreateAssistantMessage(runId) {
    if (activeRuns.has(runId)) return activeRuns.get(runId);
    var info = runSubagentInfo.get(runId);
    var row = document.createElement('div');
    row.className = 'chat-row assistant';
    if (info) row.classList.add(info.spawnDepth > 2 ? 'subagent-deep' : 'subagent');

    var text = document.createElement('div');
    text.className = 'msg-text';
    row.appendChild(text);

    var tools = document.createElement('div');
    tools.className = 'tool-calls';
    row.appendChild(tools);
    toolContainers.set(runId, tools);

    if (info) applySubagentLabel(row, info);

    messagesDiv.appendChild(row);
    activeRuns.set(runId, row);
    scrollToBottom();
    return row;
  }
  window.getOrCreateAssistantMessage = getOrCreateAssistantMessage;

  function setAssistantText(runId, fullText) {
    var row = getOrCreateAssistantMessage(runId);
    var text = row.querySelector('.msg-text');
    if (text) text.innerHTML = renderMarkdown(fullText);
    ensureToolContainer(runId, row);
    scrollToBottom();
  }

  function applySubagentLabel(row, info) {
    if (row.querySelector('.subagent-label')) return;
    var label = document.createElement('div');
    label.className = 'subagent-label';
    label.textContent = '[' + (info.subagentRole || 'Subagent') + ']' +
      (info.spawnDepth ? ' (D' + info.spawnDepth + ')' : '');
    row.insertBefore(label, row.firstChild);
  }

  // ── Tool-call cards + preservation ──────────────────────────────────────────
  function ensureToolContainer(runId, row) {
    var tools = row.querySelector('.tool-calls');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      row.appendChild(tools);
    }
    toolContainers.set(runId, tools);
    return tools;
  }

  function handleToolStart(ev) {
    var row = getOrCreateAssistantMessage(ev.runId);
    var tools = ensureToolContainer(ev.runId, row);

    var card = document.createElement('div');
    card.className = 'tool-call-card';
    card.id = 'tool-' + ev.toolCallId;
    card.innerHTML =
      '<div class="tool-call-header">' +
        '<span class="codicon codicon-tools"></span>' +
        '<span class="tool-call-name"></span>' +
        '<span class="tool-call-status running">Running</span>' +
      '</div>' +
      '<pre class="tool-call-args"></pre>' +
      '<div class="tool-call-result"></div>';
    card.querySelector('.tool-call-name').textContent = ev.toolName || 'tool';
    card.querySelector('.tool-call-args').textContent = ev.args || '';
    tools.appendChild(card);
    toolCalls.set(ev.toolCallId, card);
    scrollToBottom();
  }

  function handleToolUpdate(ev) {
    var card = toolCalls.get(ev.toolCallId);
    if (!card) return;
    var result = card.querySelector('.tool-call-result');
    var upd = result.querySelector('.tool-call-update');
    if (!upd) {
      upd = document.createElement('pre');
      upd.className = 'tool-call-update';
      result.appendChild(upd);
    }
    upd.textContent = (upd.textContent || '') + (ev.text || '');
    scrollToBottom();
  }

  function handleToolResult(ev) {
    var card = toolCalls.get(ev.toolCallId);
    if (!card) return;
    var status = card.querySelector('.tool-call-status');
    status.classList.remove('running');
    status.classList.add(ev.isError ? 'error' : 'success');
    status.textContent = ev.isError ? 'Error' : 'Complete';
    var result = card.querySelector('.tool-call-result');
    var pre = document.createElement('pre');
    pre.className = 'tool-call-output';
    pre.textContent = formatToolOutput(ev.result);
    result.appendChild(pre);
    scrollToBottom();
  }

  function formatToolOutput(result) {
    if (result == null) return '';
    if (typeof result !== 'string') {
      try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); }
    }
    var trimmed = result.trim();
    if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length < 4000) {
      try {
        var parsed = JSON.parse(trimmed);
        if (parsed && parsed.type === 'history') return 'History restored.';
        return JSON.stringify(parsed, null, 2);
      } catch (e) {}
    }
    return result;
  }

  // Re-attach a tool container if a text re-render ever detaches it.
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.removedNodes.length; j++) {
        var node = m.removedNodes[j];
        if (node.nodeType === 1 && node.classList && node.classList.contains('tool-calls')) {
          activeRuns.forEach(function (row, runId) {
            if (!row.querySelector('.tool-calls') && toolContainers.has(runId)) {
              row.appendChild(toolContainers.get(runId));
            }
          });
        }
      }
    }
  });
  observer.observe(messagesDiv, { childList: true, subtree: true });

  // ── Reasoning disclosures ───────────────────────────────────────────────────
  // Two modes (openclaw.reasoningDisplay):
  //   'expanded' — stream the reasoning expanded, auto-collapse on finish.
  //   'compact'  — collapsed "Thinking… ~N tokens" live ticker,
  //                reveal the block (expandable) after it finishes.
  var reasoningMode = 'expanded';

  function approxTokens(text) { return Math.max(1, Math.round((text || '').length / 4)); }

  // The loading-widget slot lives inside the summary. No spinner yet — this is
  // just the mount point + class hook (.thinking-loader); animation TBD.
  function summaryHtml(label) {
    return '<span class="codicon codicon-lightbulb"></span>' +
      '<span class="thinking-loader" aria-hidden="true"></span>' +
      '<span class="reasoning-label">' + label + '</span>';
  }

  function renderReasoning(runId, fullText) {
    var block = reasoningBlocks.get(runId);
    if (!block) {
      block = document.createElement('details');
      block.className = 'reasoning-disclosure thinking';
      block.open = (reasoningMode !== 'compact');
      block.innerHTML = '<summary>' + summaryHtml('') + '</summary><pre class="reasoning-content"></pre>';
      messagesDiv.appendChild(block);
      reasoningBlocks.set(runId, block);
    }
    var label = (reasoningMode === 'compact')
      ? 'Thinking… ~' + approxTokens(fullText).toLocaleString() + ' tokens'
      : 'Reasoning…';
    block.querySelector('.reasoning-label').textContent = label;
    block.querySelector('.reasoning-content').textContent = fullText || '';
    scrollToBottom();
  }

  function finalizeReasoning(runId, durationMs) {
    var block = reasoningBlocks.get(runId);
    if (!block) return;
    block.classList.remove('thinking'); // stops the (future) loading widget
    var secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
    var content = block.querySelector('.reasoning-content');
    var toks = approxTokens(content ? content.textContent : '');
    var label = (secs ? 'Thought for ' + secs + 's' : 'Reasoning') + ' · ~' + toks.toLocaleString() + ' tokens';
    block.querySelector('summary').innerHTML = summaryHtml(label);
    // expanded mode auto-collapses; compact stays collapsed but expandable.
    block.open = false;
  }

  // ── History / response ──────────────────────────────────────────────────────
  function clearMessages() {
    messagesDiv.innerHTML = '';
    activeRuns.clear();
    runSubagentInfo.clear();
    reasoningBlocks.clear();
    toolCalls.clear();
    toolContainers.clear();
  }

  function renderHistory(history) {
    clearMessages();
    (history || []).forEach(function (item) {
      if (!item || !item.content) return;
      if (item.role === 'assistant') {
        addAssistantHistoryRow(item.content);
      } else {
        addUserRow(item.content, item.messageId, item.hasCheckpoint);
      }
    });
    scrollToBottom();
  }
  window.renderHistory = renderHistory;

  // ── Inbound dispatch ────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'config':
        if (msg.reasoningDisplay) reasoningMode = msg.reasoningDisplay;
        break;
      case 'history':
        renderHistory(msg.messages);
        break;
      case 'userEcho':
        addUserRow(msg.text, msg.messageId, msg.hasCheckpoint);
        break;
      case 'checkpointReady':
        var marker = messagesDiv.querySelector('.checkpoint-marker[data-message-id="' + msg.messageId + '"]');
        if (marker) {
          marker.classList.add('available');
          marker.title = 'Checkpoint available';
        }
        break;
      case 'response':
        setAssistantText('response', msg.text);
        activeRuns.delete('response');
        break;
      case 'assistant_stream_start':
        getOrCreateAssistantMessage(msg.runId);
        break;
      case 'assistant_stream_delta':
        if (msg.fullText !== undefined) setAssistantText(msg.runId, msg.fullText);
        break;
      case 'assistant_stream_end':
        activeRuns.delete(msg.runId);
        break;
      case 'thinking_chunk':
        renderReasoning(msg.runId, msg.fullText);
        break;
      case 'thinking_end':
        finalizeReasoning(msg.runId, msg.durationMs);
        break;
      case 'tool_start':
        handleToolStart(msg);
        break;
      case 'tool_update':
        handleToolUpdate(msg);
        break;
      case 'tool_result':
        handleToolResult(msg);
        break;
      case 'subagentInfo':
        runSubagentInfo.set(msg.runId, msg);
        var row = activeRuns.get(msg.runId);
        if (row) {
          applySubagentLabel(row, msg);
          row.classList.add(msg.spawnDepth > 2 ? 'subagent-deep' : 'subagent');
        }
        break;
      case 'tokenUsage':
        var r = activeRuns.get(msg.runId);
        if (r) {
          var footer = r.querySelector('.token-footer');
          if (!footer) {
            footer = document.createElement('div');
            footer.className = 'token-footer';
            r.appendChild(footer);
          }
          footer.textContent = '↑ ' + (msg.inputTokens || 0).toLocaleString() +
            '  ↓ ' + (msg.outputTokens || 0).toLocaleString();
        }
        break;
    }
  });
})();
