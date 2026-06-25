/* ==========================================================================
   approvals.js — Inline approval / input prompts for blocking gateway requests
   --------------------------------------------------------------------------
   Renders two paradigms, chosen by the active look-and-feel layout:
     • timeline mode (body.stream-layout-timeline)  → Claude-Code-style
       permission card placed inline in the transcript.
     • compact mode (default / accordion)          → Codex-style compact row
       docked above the composer.
   Backed by the `approval_request` / `input_request` stream events; responses
   post `approvalRespond` / `inputRespond` back to the extension host.
   ========================================================================== */
(function () {
  'use strict';

  // requestId → { el, mode } for cleanup on response or supersede.
  var active = new Map();

  function isTimeline() {
    return document.body.classList.contains('stream-layout-timeline');
  }

  function messagesDiv() {
    return document.getElementById('chat-messages');
  }

  /** The dock above the composer where compact rows live (created lazily). */
  function compactDock() {
    var shell = document.getElementById('composer-shell');
    if (!shell) return null;
    var dock = document.getElementById('approval-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'approval-dock';
      dock.className = 'approval-dock';
      shell.insertBefore(dock, shell.firstChild);
    }
    return dock;
  }

  function icon(name) {
    var i = document.createElement('span');
    i.className = 'codicon codicon-' + name;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  function oneLine(text, max) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > (max || 96) ? t.slice(0, (max || 96) - 1) + '…' : t;
  }

  function removeRequest(requestId) {
    var entry = active.get(requestId);
    if (entry && entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    active.delete(requestId);
    var dock = document.getElementById('approval-dock');
    if (dock && !dock.children.length) dock.remove();
  }

  function anchorRow(runId) {
    // Place timeline cards in the active run's row when known, else append to
    // the end of the transcript.
    if (runId && window.activeRuns && typeof window.activeRuns.get === 'function') {
      var row = window.activeRuns.get(runId);
      if (row) return row;
    }
    return messagesDiv();
  }

  // ── Approval requests ──────────────────────────────────────────────────
  function defaultApprovalOptions() {
    return [
      { choice: 'once', label: window.junctionT('allowOnce', 'Allow once'), kind: 'primary' },
      { choice: 'session', label: window.junctionT('allowForSession', 'Allow for session'), kind: 'normal' },
      { choice: 'always', label: window.junctionT('alwaysAllow', 'Always allow'), kind: 'normal' },
      { choice: 'deny', label: window.junctionT('deny', 'Deny'), kind: 'danger' },
    ];
  }

  // Bridges may supply an explicit option list (OpenClaw advertises the exact
  // allowed decisions); otherwise fall back to the default set, dropping the
  // permanent option when the gateway forbids it (Hermes Tirith gate).
  function optionsFor(msg) {
    if (Array.isArray(msg.options) && msg.options.length) {
      return msg.options.filter(function (o) { return o && o.choice && o.label; });
    }
    var allowPermanent = msg.allowPermanent !== false;
    return defaultApprovalOptions().filter(function (opt) { return !(opt.choice === 'always' && !allowPermanent); });
  }

  function respondApproval(requestId, choice, all) {
    vscode.postMessage({ type: 'approvalRespond', requestId: requestId, choice: choice, all: !!all });
    removeRequest(requestId);
  }

  function renderApprovalTimeline(msg) {
    var card = document.createElement('div');
    card.className = 'permission-request perm-timeline';
    card.setAttribute('data-request-id', msg.requestId);

    var header = document.createElement('div');
    header.className = 'permission-request-header';
    header.appendChild(icon('shield'));
    var title = document.createElement('span');
    title.textContent = (msg.toolName ? msg.toolName + ' ' : '') + 'needs your approval';
    header.appendChild(title);
    card.appendChild(header);

    if (msg.description) {
      var desc = document.createElement('div');
      desc.className = 'permission-request-description';
      desc.textContent = msg.description;
      card.appendChild(desc);
    }
    if (msg.command) {
      var pre = document.createElement('pre');
      pre.className = 'permission-request-input';
      pre.textContent = msg.command;
      card.appendChild(pre);
    }

    var actions = document.createElement('div');
    actions.className = 'permission-request-actions';
    optionsFor(msg).forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'perm-btn perm-' + (opt.kind || (opt.choice === 'deny' ? 'danger' : (opt.choice === 'once' ? 'primary' : 'normal')));
      b.textContent = opt.label;
      b.addEventListener('click', function () { respondApproval(msg.requestId, opt.choice, false); });
      actions.appendChild(b);
    });
    card.appendChild(actions);
    return card;
  }

  function renderApprovalCompact(msg) {
    var row = document.createElement('div');
    row.className = 'approval-dock-row perm-compact';
    row.setAttribute('data-request-id', msg.requestId);

    var summary = document.createElement('span');
    summary.className = 'approval-summary';
    summary.appendChild(icon('shield'));
    var text = document.createElement('span');
    text.className = 'approval-summary-text';
    text.textContent = (msg.toolName ? msg.toolName + ': ' : '') + oneLine(msg.command || msg.description || 'approval required');
    text.title = msg.command || msg.description || '';
    summary.appendChild(text);
    row.appendChild(summary);

    var allowPermanent = msg.allowPermanent !== false;
    var cb = null;
    var dontask = null;
    if (allowPermanent) {
      dontask = document.createElement('label');
      dontask.className = 'approval-dontask';
      cb = document.createElement('input');
      cb.type = 'checkbox';
      dontask.appendChild(cb);
      dontask.appendChild(document.createTextNode(window.junctionT('dontAskAgain', "Don't ask again")));
    }

    var actions = document.createElement('div');
    actions.className = 'approval-compact-actions';
    var approve = document.createElement('button');
    approve.className = 'perm-btn perm-primary';
    approve.textContent = window.junctionT('approve', 'Approve');
    approve.addEventListener('click', function () { respondApproval(msg.requestId, (cb && cb.checked) ? 'always' : 'once', false); });
    var deny = document.createElement('button');
    deny.className = 'perm-btn perm-danger';
    deny.textContent = window.junctionT('deny', 'Deny');
    deny.addEventListener('click', function () { respondApproval(msg.requestId, 'deny', false); });
    actions.appendChild(approve);
    actions.appendChild(deny);

    if (dontask) row.appendChild(dontask);
    row.appendChild(actions);
    return row;
  }

  function handleApprovalRequest(msg) {
    if (!msg || !msg.requestId) return;
    if (active.has(msg.requestId)) removeRequest(msg.requestId);
    if (isTimeline()) {
      var card = renderApprovalTimeline(msg);
      var anchor = anchorRow(msg.runId);
      if (anchor) anchor.appendChild(card);
      active.set(msg.requestId, { el: card, mode: 'timeline' });
    } else {
      var dock = compactDock();
      if (!dock) return;
      var row = renderApprovalCompact(msg);
      dock.appendChild(row);
      active.set(msg.requestId, { el: row, mode: 'compact' });
    }
  }

  // ── Input requests (secret / sudo / clarify / terminal-read) ─────────────
  function respondInput(requestId, kind, value) {
    vscode.postMessage({ type: 'inputRespond', requestId: requestId, kind: kind, value: value });
    removeRequest(requestId);
  }

  function buildInputCard(msg, compact) {
    var card = document.createElement('div');
    card.className = (compact ? 'approval-dock-row ' : 'permission-request perm-timeline ') + 'input-request';
    card.setAttribute('data-request-id', msg.requestId);

    var header = document.createElement('div');
    header.className = compact ? 'approval-summary' : 'permission-request-header';
    header.appendChild(icon(msg.secret ? 'key' : 'comment-discussion'));
    var label = document.createElement('span');
    label.textContent = msg.prompt || (msg.secret ? window.junctionT('enterSecret', 'Enter secret') : window.junctionT('inputRequested', 'Input requested'));
    header.appendChild(label);
    card.appendChild(header);

    var field = document.createElement('input');
    field.type = msg.secret ? 'password' : 'text';
    field.className = 'approval-input-field';
    field.setAttribute('autocomplete', msg.secret ? 'off' : 'on');

    var submit = function () { respondInput(msg.requestId, msg.kind, field.value); };
    field.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    var actions = document.createElement('div');
    actions.className = compact ? 'approval-compact-actions' : 'permission-request-actions';
    var ok = document.createElement('button');
    ok.className = 'perm-btn perm-primary';
    ok.textContent = window.junctionT('submit', 'Submit');
    ok.addEventListener('click', submit);
    var cancel = document.createElement('button');
    cancel.className = 'perm-btn perm-danger';
    cancel.textContent = window.junctionT('cancel', 'Cancel');
    cancel.addEventListener('click', function () { respondInput(msg.requestId, msg.kind, ''); });
    actions.appendChild(ok);
    actions.appendChild(cancel);

    card.appendChild(field);
    card.appendChild(actions);
    setTimeout(function () { try { field.focus(); } catch (e) {} }, 0);
    return card;
  }

  function handleInputRequest(msg) {
    if (!msg || !msg.requestId) return;
    if (active.has(msg.requestId)) removeRequest(msg.requestId);
    if (isTimeline()) {
      var card = buildInputCard(msg, false);
      var anchor = anchorRow(msg.runId);
      if (anchor) anchor.appendChild(card);
      active.set(msg.requestId, { el: card, mode: 'timeline' });
    } else {
      var dock = compactDock();
      if (!dock) return;
      var row = buildInputCard(msg, true);
      dock.appendChild(row);
      active.set(msg.requestId, { el: row, mode: 'compact' });
    }
  }

  // ── Status line (transient) ─────────────────────────────────────────────
  var statusTimer = null;
  function handleStatus(msg) {
    var dock = document.getElementById('composer-shell');
    if (!dock) return;
    var line = document.getElementById('approval-status-line');
    var text = String(msg && msg.text ? msg.text : '').trim();
    if (!text) { if (line) line.remove(); return; }
    if (!line) {
      line = document.createElement('div');
      line.id = 'approval-status-line';
      line.className = 'approval-status-line';
      dock.insertBefore(line, dock.firstChild);
    }
    line.textContent = text;
    line.setAttribute('data-kind', String(msg.kind || 'status'));
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { if (line && line.parentNode) line.remove(); }, 6000);
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  window.handleApprovalRequest = handleApprovalRequest;
  window.handleInputRequest = handleInputRequest;

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'approvalRequest') handleApprovalRequest(msg);
    else if (msg.type === 'inputRequest') handleInputRequest(msg);
    else if (msg.type === 'status') handleStatus(msg);
    else if (msg.type === 'clearChat') { active.forEach(function (_v, k) { removeRequest(k); }); }
  });
})();
