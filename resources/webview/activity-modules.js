/* ==========================================================================
   activity-modules.js - Lazy loaders for layout-specific activity modules.
   ========================================================================== */
(function () {
  'use strict';

  var timelineState = 'idle';
  var timelineQueue = [];
  var scriptNonce = document.currentScript && (document.currentScript.nonce || document.currentScript.getAttribute('nonce'));
  var normalizingSummaryPills = false;
  var lastActivityLayout = null;

  function currentActivityLayout() {
    if (document.body.classList.contains('stream-layout-timeline')) return 'timeline';
    return 'accordion';
  }

  function clearTimelineStickyUserRows() {
    document.querySelectorAll('#chat-messages .chat-row.user').forEach(function (row) {
      row.classList.remove('timeline-sticky-user', 'timeline-user-pinnable', 'sticky-user-row', 'accordion-sticky-user');
    });
  }
  window.clearTimelineStickyUserRows = clearTimelineStickyUserRows;

  function flushTimelineQueue() {
    var queue = timelineQueue.splice(0);
    queue.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  function ensureTimelineActivityModule(callback) {
    if (window.syncTimelineStickyUserRows) {
      window.syncTimelineStickyUserRows();
      if (callback) callback();
      return;
    }
    if (callback) timelineQueue.push(callback);
    if (timelineState === 'loading') return;
    if (timelineState === 'failed') return;
    var src = window.JUNCTION_ACTIVITY_TIMELINE_JS_URI;
    if (!src) {
      timelineState = 'failed';
      return;
    }
    timelineState = 'loading';
    var script = document.createElement('script');
    if (scriptNonce) script.setAttribute('nonce', scriptNonce);
    script.src = src;
    script.onload = function () {
      timelineState = 'loaded';
      if (window.syncTimelineStickyUserRows) window.syncTimelineStickyUserRows();
      flushTimelineQueue();
    };
    script.onerror = function () {
      timelineState = 'failed';
      timelineQueue.length = 0;
    };
    document.head.appendChild(script);
  }
  window.ensureTimelineActivityModule = ensureTimelineActivityModule;

  function directChildren(node, predicate) {
    if (!node) return [];
    return Array.prototype.slice.call(node.children || []).filter(predicate);
  }

  function unwrapSummaryGroup(group) {
    var parent = group && group.parentNode;
    var body = group && group.querySelector(':scope > .tool-group-body');
    if (!parent || !body) {
      if (group) group.remove();
      return;
    }
    while (body.firstChild) parent.insertBefore(body.firstChild, group);
    group.remove();
  }

  function moveSummaryGroupsToBottom(container) {
    var children = Array.prototype.slice.call(container.children || []);
    var groups = children.filter(function (node) {
      return node.classList && node.classList.contains('tool-group');
    });
    if (!groups.length) return;
    var firstGroup = children.indexOf(groups[0]);
    var lastNonGroup = -1;
    children.forEach(function (node, index) {
      if (!node.classList || !node.classList.contains('tool-group')) lastNonGroup = index;
    });
    if (lastNonGroup <= firstGroup) return;
    groups.forEach(function (group) {
      if (group.parentNode === container) container.appendChild(group);
    });
  }

  function editPathForRow(row) {
    if (!row) return '';
    var explicit = row.getAttribute('data-file') || '';
    if (explicit) return explicit;
    var link = row.querySelector('.file-link[data-file], .file-group-name[data-file]');
    if (link) return link.getAttribute('data-file') || link.getAttribute('title') || link.textContent || '';
    var target = row.getAttribute('data-target') || '';
    return target || 'file';
  }

  function signedCount(row, selector) {
    var total = 0;
    row.querySelectorAll(selector).forEach(function (el) {
      total += parseInt(String(el.textContent || '').replace(/[^\d-]/g, ''), 10) || 0;
    });
    return total;
  }

  function buildEditSummarySignature(row) {
    var byPath = new Map();
    row.querySelectorAll('.tool-row[data-kind="edit"]').forEach(function (toolRow) {
      var path = editPathForRow(toolRow);
      if (!path) return;
      var current = byPath.get(path) || { path: path, plus: 0, minus: 0 };
      current.plus += signedCount(toolRow, '.diff-plus');
      current.minus += Math.abs(signedCount(toolRow, '.diff-minus'));
      byPath.set(path, current);
    });
    var files = Array.from(byPath.values()).sort(function (a, b) {
      return a.path.localeCompare(b.path);
    });
    if (!files.length) return null;
    return JSON.stringify(files);
  }

  function shortPath(path) {
    var value = String(path || '');
    var cwd = '';
    try { cwd = window.workspacePath || ''; } catch (e) {}
    if (cwd && value.indexOf(cwd + '/') === 0) return value.slice(cwd.length + 1);
    return value;
  }

  function checkpointMessageIdForRow(row) {
    var cursor = row && row.previousElementSibling;
    while (cursor) {
      if (cursor.classList && cursor.classList.contains('chat-row') && cursor.classList.contains('user')) {
        var messageId = cursor.getAttribute('data-message-id');
        if (messageId) return messageId;
      }
      cursor = cursor.previousElementSibling;
    }
    return row ? (row.getAttribute('data-message-id') || row.getAttribute('data-run-id') || '') : '';
  }

  function renderEditSummary(row, signature) {
    var files = JSON.parse(signature || '[]');
    var card = row.querySelector(':scope > .accordion-edit-summary-card');
    if (!files.length) {
      if (card) card.remove();
      return;
    }
    if (!card) {
      card = document.createElement('details');
      card.className = 'accordion-edit-summary-card';
      card.open = true;
      row.appendChild(card);
    }
    if (card.getAttribute('data-signature') === signature) return;
    card.setAttribute('data-signature', signature);
    var checkpointMessageId = checkpointMessageIdForRow(row);
    if (checkpointMessageId) card.setAttribute('data-checkpoint-message-id', checkpointMessageId);
    else card.removeAttribute('data-checkpoint-message-id');
    var totalPlus = files.reduce(function (sum, f) { return sum + (f.plus || 0); }, 0);
    var totalMinus = files.reduce(function (sum, f) { return sum + (f.minus || 0); }, 0);
    card.innerHTML = '';

    var summary = document.createElement('summary');
    summary.className = 'accordion-edit-summary-head';

    var icon = document.createElement('span');
    icon.className = 'codicon codicon-diff-added accordion-edit-summary-icon';
    icon.setAttribute('aria-hidden', 'true');
    summary.appendChild(icon);

    var meta = document.createElement('span');
    meta.className = 'accordion-edit-summary-meta';
    var title = document.createElement('span');
    title.className = 'accordion-edit-summary-title';
    title.textContent = window.junctionT('editedFilesCount', 'Edited {count} file(s):', { count: files.length });
    meta.appendChild(title);
    var diff = document.createElement('span');
    diff.className = 'accordion-edit-summary-diff';
    if (totalPlus) {
      var plus = document.createElement('span');
      plus.className = 'diff-plus';
      plus.textContent = '+' + totalPlus;
      diff.appendChild(plus);
    }
    if (totalMinus) {
      var minus = document.createElement('span');
      minus.className = 'diff-minus';
      minus.textContent = '-' + totalMinus;
      diff.appendChild(minus);
    }
    meta.appendChild(diff);
    summary.appendChild(meta);

    var actions = document.createElement('span');
    actions.className = 'accordion-edit-summary-actions';
    [
      { label: window.junctionT('review', 'Review'), type: 'reviewCheckpointDiff' },
    ].forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: action.type,
          messageId: checkpointMessageId,
          files: files.map(function (file) { return file.path; }),
        });
      });
      actions.appendChild(btn);
    });
    summary.appendChild(actions);
    card.appendChild(summary);

    var list = document.createElement('div');
    list.className = 'accordion-edit-summary-list';
    files.slice(0, 4).forEach(function (file) {
      var item = document.createElement('div');
      item.className = 'accordion-edit-summary-file';
      var name = document.createElement('span');
      name.className = 'accordion-edit-summary-path';
      name.textContent = shortPath(file.path);
      name.title = file.path;
      item.appendChild(name);
      var stat = document.createElement('span');
      stat.className = 'accordion-edit-summary-file-diff';
      if (file.plus) {
        var itemPlus = document.createElement('span');
        itemPlus.className = 'diff-plus';
        itemPlus.textContent = '+' + file.plus;
        stat.appendChild(itemPlus);
      }
      if (file.minus) {
        var itemMinus = document.createElement('span');
        itemMinus.className = 'diff-minus';
        itemMinus.textContent = '-' + file.minus;
        stat.appendChild(itemMinus);
      }
      item.appendChild(stat);
      list.appendChild(item);
    });
    if (files.length > 4) {
      var more = document.createElement('div');
      more.className = 'accordion-edit-summary-more';
      more.textContent = window.junctionT('showMoreFiles', 'Show {count} more file(s)', { count: files.length - 4 });
      list.appendChild(more);
    }
    card.appendChild(list);
  }

  function syncAccordionEditSummaries() {
    document.querySelectorAll('#chat-messages .chat-row.assistant').forEach(function (row) {
      var signature = buildEditSummarySignature(row);
      renderEditSummary(row, signature);
    });
  }

  function removeAccordionEditSummaries() {
    document.querySelectorAll('#chat-messages .accordion-edit-summary-card').forEach(function (card) { card.remove(); });
  }

  function normalizeSummaryPills() {
    if (normalizingSummaryPills) return;
    normalizingSummaryPills = true;
    try {
      var layout = currentActivityLayout();
      if (layout === 'timeline') {
        document.querySelectorAll('#chat-messages .tool-calls .tool-group').forEach(unwrapSummaryGroup);
        if (lastActivityLayout === 'accordion') removeAccordionEditSummaries();
        lastActivityLayout = layout;
        return;
      }
      document.querySelectorAll('#chat-messages .tool-calls, #chat-messages .accordion-root-thought').forEach(moveSummaryGroupsToBottom);
      syncAccordionEditSummaries();
      lastActivityLayout = layout;
    } finally {
      normalizingSummaryPills = false;
    }
  }
  window.normalizeSummaryPills = normalizeSummaryPills;

  var messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv && typeof MutationObserver !== 'undefined') {
    var summaryObserver = new MutationObserver(function () { normalizeSummaryPills(); });
    summaryObserver.observe(messagesDiv, { childList: true, subtree: true });
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function () { normalizeSummaryPills(); }).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  normalizeSummaryPills();
})();
