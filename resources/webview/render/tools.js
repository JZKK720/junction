/* ==========================================================================
   tools.js — Tool-call cards, handlers, classification, grouping, rendering
   ========================================================================== */
(function () {
  'use strict';

  // ── Tool call storage (shared via window) ────────────────────────────────
  // toolCalls and toolContainers are owned by messages.js but shared globally

  // ── Tool card helpers ────────────────────────────────────────────────────
  function truncateArgs(args) {
    if (!args) return '';
    var oneLine = String(args).replace(/\n/g, ' ').trim();
    return oneLine.length > 60 ? oneLine.substring(0, 57) + '...' : oneLine;
  }

  function stringifyArgs(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    try { return JSON.stringify(args, null, 2); } catch (e) { return String(args); }
  }

  function parseArgsObject(args) {
    if (!args) return null;
    if (typeof args === 'object') return args;
    var t = String(args).trim();
    if (t[0] !== '{' && t[0] !== '[') return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function baseName(p) {
    if (!p) return '';
    var parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || String(p);
  }

  function lineCount(text) {
    if (text == null || text === '') return 0;
    return String(text).split('\n').length;
  }

  function getFirstString(obj, keys) {
    if (!obj) return '';
    for (var i = 0; i < keys.length; i++) {
      var value = obj[keys[i]];
      if (typeof value === 'string' && value.length) return value;
    }
    return '';
  }

  function diffStatFromPatch(patch) {
    var plus = 0, minus = 0;
    String(patch || '').split('\n').forEach(function (line) {
      if (/^\+(?!\+\+)/.test(line)) plus++;
      else if (/^-(?!--)/.test(line)) minus++;
    });
    return { plus: plus, minus: minus };
  }

  function patchFileName(patch) {
    var m = String(patch || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/) ||
            String(patch || '').match(/\+\+\+ [ab]\/(.+)/);
    return m ? baseName(m[1].trim()) : '';
  }

  var FILE_ARG_KEYS = ['path', 'file_path', 'filePath', 'file', 'target_file', 'filename'];
  function extractFilePath(obj) {
    if (!obj) return '';
    for (var i = 0; i < FILE_ARG_KEYS.length; i++) {
      if (typeof obj[FILE_ARG_KEYS[i]] === 'string') return obj[FILE_ARG_KEYS[i]];
    }
    return '';
  }

  // ── classifyTool ─────────────────────────────────────────────────────────
  function classifyTool(toolName, args) {
    var raw = String(toolName || 'tool');
    var name = raw.toLowerCase();
    var obj = parseArgsObject(args) || {};
    var file = extractFilePath(obj);
    var meta = { kind: 'other', verb: raw, target: '', plus: 0, minus: 0, mono: false, icon: 'tools' };

    if (/(^|_)(exec|bash|shell|terminal|process)/.test(name) || /run_command|run_terminal/.test(name) || name === 'run') {
      meta.kind = 'exec'; meta.verb = 'Ran'; meta.mono = true;
      meta.target = String(obj.command || obj.cmd || obj.script || truncateArgs(stringifyArgs(args)));
    } else if (/apply_patch|apply_diff|(^|_)patch/.test(name)) {
      meta.kind = 'edit'; meta.verb = 'Edited';
      var patchText = String(obj.patch || obj.diff || obj.input || stringifyArgs(args));
      var stat = diffStatFromPatch(patchText);
      meta.plus = stat.plus; meta.minus = stat.minus;
      meta.target = baseName(file) || patchFileName(patchText) || 'patch';
    } else if (/str_replace|multi_edit|(^|_)edit|(^|_)replace/.test(name)) {
      meta.kind = 'edit'; meta.verb = 'Edited';
      meta.target = baseName(file) || 'file';
      if (Array.isArray(obj.edits)) {
        obj.edits.forEach(function (e) {
          meta.plus += lineCount(e.new_string || e.newText || e.new_str);
          meta.minus += lineCount(e.old_string || e.oldText || e.old_str);
        });
      } else {
        meta.plus = lineCount(obj.new_string || obj.newText || obj.new_str || obj.replacement || obj.content);
        meta.minus = lineCount(obj.old_string || obj.oldText || obj.old_str || obj.search);
      }
    } else if (/(^|_)(write|create)/.test(name) && (file || obj.content !== undefined)) {
      meta.kind = 'edit'; meta.verb = 'Added';
      meta.target = baseName(file) || 'file';
      meta.plus = lineCount(obj.content || obj.text || '');
    } else if (/fetch|browser|(^|_)web|http|curl|download/.test(name)) {
      meta.kind = 'fetch'; meta.verb = 'Fetched';
      meta.target = String(obj.url || obj.query || truncateArgs(stringifyArgs(args)));
    } else if (/(^|_)(read|cat|open|view)/.test(name)) {
      meta.kind = 'explore'; meta.verb = 'Read';
      meta.target = baseName(file) || truncateArgs(stringifyArgs(args));
    } else if (/grep|search|glob|find|(^|_)(ls|list|tree)/.test(name)) {
      var listing = /(^|_)(ls|list|tree)/.test(name);
      meta.kind = 'explore'; meta.verb = listing ? 'Listed' : 'Searched';
      meta.mono = !listing;
      meta.target = String(obj.pattern || obj.query || obj.regex || file || truncateArgs(stringifyArgs(args)));
    } else if (/todo|(^|_)plan/.test(name)) {
      meta.kind = 'plan'; meta.verb = 'Updated plan';
    } else if (/agent|task|spawn/.test(name)) {
      meta.kind = 'agent'; meta.verb = 'Delegated';
      meta.target = String(obj.description || obj.task || obj.prompt || '');
    } else {
      meta.mono = true;
      meta.target = truncateArgs(stringifyArgs(args));
    }
    if (meta.kind === 'edit') meta.icon = (meta.verb === 'Added') ? 'file-add' : 'edit';
    else if (meta.kind === 'exec') meta.icon = 'terminal';
    else if (meta.kind === 'fetch') meta.icon = 'globe';
    else if (meta.kind === 'explore') meta.icon = (meta.verb === 'Listed') ? 'list-tree' : (meta.verb === 'Searched' ? 'search' : 'book');
    else if (meta.kind === 'plan') meta.icon = 'checklist';
    else if (meta.kind === 'agent') meta.icon = 'robot';
    meta.target = truncateArgs(meta.target);
    return meta;
  }

  // ── buildDetailSection ───────────────────────────────────────────────────
  function buildDetailSection(label, text, lang, opts) {
    opts = opts || {};
    var sectionTag = opts.collapsible ? 'details' : 'div';
    var section = document.createElement(sectionTag);
    section.className = 'tool-detail-section' + (opts.collapsible ? ' code-editor tool-detail-leaf' : '');
    section.setAttribute('data-section', label.toLowerCase());
    if (opts.collapsible) section.open = opts.open !== false;

    var isJson = false;
    var trimmed = String(text || '').trim();
    if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 2) {
      try { JSON.parse(trimmed); isJson = true; } catch (e) {}
    }
    var displayLang = lang || (isJson ? 'json' : undefined);

    var editor = opts.collapsible ? section : document.createElement('div');
    if (!opts.collapsible) editor.className = 'code-editor';

    var headerTag = opts.collapsible ? 'summary' : 'div';
    var header = document.createElement(headerTag);
    header.className = 'code-editor-header' + (opts.collapsible ? ' tool-detail-leaf-summary' : '');

    var labelEl = document.createElement('span');
    labelEl.className = 'code-editor-label';
    labelEl.textContent = label;
    header.appendChild(labelEl);

    if (displayLang) {
      var langEl = document.createElement('span');
      langEl.className = 'code-editor-lang';
      langEl.textContent = displayLang;
      header.appendChild(langEl);
    }

    var copyBtn = document.createElement('button');
    copyBtn.className = 'code-editor-copy';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>';
    if (opts.collapsible) {
      copyBtn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
    }
    header.appendChild(copyBtn);

    copyBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'copyToClipboard', text: text });
      copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
      setTimeout(function () { copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 1500);
    });

    if (opts.collapsible) appendChevron(header);

    var body = document.createElement('div');
    body.className = 'code-editor-body' + (opts.collapsible ? ' tool-detail-leaf-body' : '');
    var code = document.createElement('pre');
    code.className = 'code-editor-code';
    if (isJson) { code.innerHTML = window.syntaxHighlightJson(text); }
    else if (label === 'Log') { code.textContent = text; }
    else { code.innerHTML = window.simpleHighlight(text, lang || 'javascript'); }
    body.appendChild(code);

    editor.appendChild(header);
    editor.appendChild(body);
    if (!opts.collapsible) section.appendChild(editor);
    return section;
  }

  function setToolRowStatus(row, statusClass) {
    var status = row.querySelector('.tool-row-status');
    if (!status) return;
    status.classList.remove('running', 'done', 'error');
    status.classList.add(statusClass);
    var iconName = row.getAttribute('data-icon') || 'tools';
    status.innerHTML = '<span class="codicon codicon-' + iconName + ' tool-status-icon" aria-hidden="true"></span>';
  }

  function appendChevron(parent) {
    var chevron = document.createElement('span');
    chevron.className = 'codicon codicon-chevron-right tool-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    parent.appendChild(chevron);
  }

  function inferLanguageFromPath(path) {
    var lower = String(path || '').toLowerCase();
    if (/\.tsx?$/.test(lower)) return 'typescript';
    if (/\.jsx?$/.test(lower)) return 'javascript';
    if (/\.json[cl]?$/.test(lower)) return 'json';
    if (/\.ya?ml$/.test(lower)) return 'yaml';
    if (/\.mdx?$/.test(lower)) return 'markdown';
    if (/\.html?$/.test(lower)) return 'html';
    if (/\.css$/.test(lower)) return 'css';
    if (/\.scss$/.test(lower)) return 'scss';
    if (/\.py$/.test(lower)) return 'python';
    if (/\.rs$/.test(lower)) return 'rust';
    if (/\.go$/.test(lower)) return 'go';
    if (/\.sh$/.test(lower)) return 'bash';
    return 'text';
  }

  function parseResultObject(result) {
    if (result == null) return null;
    if (typeof result === 'object') return result;
    var trimmed = String(result).trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try { return JSON.parse(trimmed); } catch (e) { return null; }
  }

  function deriveResultMeta(result, isError) {
    var parsed = parseResultObject(result);
    var meta = {
      isError: !!isError,
      statusText: '',
      errorText: '',
      fileText: '',
      rawOutput: formatToolOutput(result),
      showRawOutput: true
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return meta;

    if (typeof parsed.status === 'string') {
      meta.statusText = parsed.status;
      if (/error|failed|failure/i.test(parsed.status)) meta.isError = true;
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      meta.errorText = parsed.error.trim();
      meta.isError = true;
    }
    if (typeof parsed.message === 'string' && /error|failed/i.test(meta.statusText || '')) {
      meta.errorText = meta.errorText || parsed.message.trim();
    }
    if (typeof parsed.output === 'string' && !meta.errorText && /error|failed/i.test(meta.statusText || '')) {
      meta.errorText = parsed.output.trim();
    }

    var marker = '\nCurrent file contents:\n';
    if (meta.errorText && meta.errorText.indexOf(marker) >= 0) {
      var parts = meta.errorText.split(marker);
      meta.errorText = parts.shift().trim();
      meta.fileText = parts.join(marker).trim();
    }

    if (meta.isError && (meta.errorText || meta.fileText)) {
      meta.showRawOutput = false;
    }
    return meta;
  }

  function parseApplyPatchChanges(patchText) {
    var text = String(patchText || '');
    if (!text) return [];
    var lines = text.split('\n');
    var changes = [];
    var currentFile = '';
    var currentOld = [];
    var currentNew = [];

    function flushChange() {
      if (!currentOld.length && !currentNew.length) return;
      changes.push({
        path: currentFile || 'patch',
        oldText: currentOld.join('\n'),
        newText: currentNew.join('\n'),
        language: inferLanguageFromPath(currentFile)
      });
      currentOld = [];
      currentNew = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
      if (fileMatch) {
        flushChange();
        currentFile = fileMatch[1].trim();
        continue;
      }
      if (/^\*\*\* /.test(line) || /^@@/.test(line)) {
        flushChange();
        continue;
      }
      if (/^\+(?!\+\+)/.test(line)) {
        currentNew.push(line.slice(1));
        continue;
      }
      if (/^-(?!--)/.test(line)) {
        currentOld.push(line.slice(1));
      }
    }
    flushChange();
    return changes;
  }

  function parseEditChanges(toolName, args) {
    var name = String(toolName || '').toLowerCase();
    var obj = parseArgsObject(args);
    if (!obj) return [];
    var filePath = extractFilePath(obj);
    var language = inferLanguageFromPath(filePath);

    if (/apply_patch|apply_diff|(^|_)patch/.test(name)) {
      return parseApplyPatchChanges(obj.patch || obj.diff || obj.input || '');
    }

    if (Array.isArray(obj.edits) && obj.edits.length) {
      return obj.edits.map(function (edit, index) {
        var editPath = extractFilePath(edit) || filePath || ('edit-' + (index + 1));
        return {
          path: editPath,
          oldText: getFirstString(edit, ['old_string', 'oldText', 'old_str', 'search']),
          newText: getFirstString(edit, ['new_string', 'newText', 'new_str', 'replacement', 'content']),
          language: inferLanguageFromPath(editPath)
        };
      });
    }

    if (/str_replace|multi_edit|(^|_)edit|(^|_)replace|(^|_)(write|create)/.test(name)) {
      return [{
        path: filePath || 'file',
        oldText: getFirstString(obj, ['old_string', 'oldText', 'old_str', 'search']),
        newText: getFirstString(obj, ['new_string', 'newText', 'new_str', 'replacement', 'content', 'text']),
        language: language
      }];
    }

    return [];
  }

  function buildEditPreviewSection(toolName, args) {
    var changes = parseEditChanges(toolName, args).filter(function (change) {
      return change && (change.oldText || change.newText);
    });
    if (!changes.length) return null;

    var section = document.createElement('div');
    section.className = 'tool-detail-section tool-edit-previews';
    section.setAttribute('data-section', 'changes');

    var title = document.createElement('div');
    title.className = 'tool-edit-previews-title';
    title.textContent = changes.length === 1 ? 'Change' : ('Changes (' + changes.length + ')');
    section.appendChild(title);

    changes.forEach(function (change, index) {
      var wrapper = document.createElement('details');
      wrapper.className = 'tool-edit-preview';
      if (changes.length === 1 && index === 0) wrapper.open = true;

      var summary = document.createElement('summary');
      summary.className = 'tool-edit-preview-summary';

      var fileEl = document.createElement('span');
      fileEl.className = 'tool-edit-preview-file';
      fileEl.textContent = change.path || ('edit-' + (index + 1));
      summary.appendChild(fileEl);

      var statsEl = document.createElement('span');
      statsEl.className = 'tool-edit-preview-stats';
      if (change.oldText) {
        var minusEl = document.createElement('span');
        minusEl.className = 'diff-minus';
        minusEl.textContent = '-' + lineCount(change.oldText);
        statsEl.appendChild(minusEl);
      }
      if (change.newText) {
        var plusEl = document.createElement('span');
        plusEl.className = 'diff-plus';
        plusEl.textContent = '+' + lineCount(change.newText);
        statsEl.appendChild(plusEl);
      }
      summary.appendChild(statsEl);
      appendChevron(summary);
      wrapper.appendChild(summary);

      var body = document.createElement('div');
      body.className = 'tool-edit-preview-body';

      if (change.oldText) {
        var beforeWrap = document.createElement('details');
        beforeWrap.className = 'tool-edit-subsection tool-edit-old';
        var beforeSummary = document.createElement('summary');
        beforeSummary.className = 'tool-edit-subsection-summary';
        beforeSummary.textContent = 'Old text';
        appendChevron(beforeSummary);
        beforeWrap.appendChild(beforeSummary);
        beforeWrap.appendChild(buildDetailSection('Old text', change.oldText, change.language));
        body.appendChild(beforeWrap);
      }

      if (change.newText) {
        var afterWrap = document.createElement('details');
        afterWrap.className = 'tool-edit-subsection tool-edit-new';
        afterWrap.open = true;
        var afterSummary = document.createElement('summary');
        afterSummary.className = 'tool-edit-subsection-summary';
        afterSummary.textContent = 'New text';
        appendChevron(afterSummary);
        afterWrap.appendChild(afterSummary);
        afterWrap.appendChild(buildDetailSection('New text', change.newText, change.language));
        body.appendChild(afterWrap);
      }

      wrapper.appendChild(body);
      section.appendChild(wrapper);
    });

    return section;
  }

  // ── buildToolRow ─────────────────────────────────────────────────────────
  function buildToolRow(tool) {
    var meta = classifyTool(tool.toolName, tool.args);
    var resultMeta = deriveResultMeta(tool.result, tool.isError);
    var details = document.createElement('details');
    details.className = 'tool-row';
    details._toolArgs = tool.args;
    details.setAttribute('data-kind', meta.kind);
    details.setAttribute('data-target', meta.target);
    details.setAttribute('data-icon', meta.icon);
    var statusClass = resultMeta.isError ? 'error' : (tool.phase === 'result' ? 'done' : 'running');
    var summary = document.createElement('summary');
    summary.className = 'tool-row-summary';

    var status = document.createElement('span');
    status.className = 'tool-row-status ' + statusClass;
    status.setAttribute('aria-hidden', 'true');
    status.innerHTML = '<span class="codicon codicon-' + meta.icon + ' tool-status-icon" aria-hidden="true"></span>';
    summary.appendChild(status);

    var verb = document.createElement('span');
    verb.className = 'tool-verb';
    verb.textContent = meta.verb;
    summary.appendChild(verb);

    if (meta.target) {
      var target = document.createElement('span');
      target.className = 'tool-target' + (meta.mono ? ' mono' : '');
      target.textContent = meta.target;
      summary.appendChild(target);
    }

    if (!resultMeta.isError && (meta.plus || meta.minus)) {
      var diff = document.createElement('span');
      diff.className = 'tool-diff';
      if (meta.plus) {
        var plus = document.createElement('span');
        plus.className = 'diff-plus';
        plus.textContent = '+' + meta.plus;
        diff.appendChild(plus);
      }
      if (meta.minus) {
        var minus = document.createElement('span');
        minus.className = 'diff-minus';
        minus.textContent = '-' + meta.minus;
        diff.appendChild(minus);
      }
      summary.appendChild(diff);
    }

    if (resultMeta.isError) {
      var errorBadge = document.createElement('span');
      errorBadge.className = 'tool-summary-badge error';
      errorBadge.textContent = 'Error';
      summary.appendChild(errorBadge);
    } else if (resultMeta.statusText && tool.phase === 'result') {
      var statusBadge = document.createElement('span');
      statusBadge.className = 'tool-summary-badge';
      statusBadge.textContent = resultMeta.statusText;
      summary.appendChild(statusBadge);
    }

    appendChevron(summary);
    details.appendChild(summary);

    var detail = document.createElement('div');
    detail.className = 'tool-detail';
    details.appendChild(detail);

    var argsText = stringifyArgs(tool.args);
    var editPreview = buildEditPreviewSection(tool.toolName, tool.args);
    if (editPreview) detail.appendChild(editPreview);
    if (resultMeta.errorText) detail.appendChild(buildDetailSection('Error', resultMeta.errorText, 'text', { collapsible: true, open: true }));
    if (resultMeta.fileText) detail.appendChild(buildDetailSection('File text', resultMeta.fileText, inferLanguageFromPath(extractFilePath(parseArgsObject(tool.args) || {})), { collapsible: true, open: false }));
    if (argsText && argsText !== '{}') detail.appendChild(buildDetailSection('Input', argsText, undefined, { collapsible: true }));
    if (tool.updates) detail.appendChild(buildDetailSection('Log', tool.updates, undefined, { collapsible: true }));
    if (tool.result && resultMeta.showRawOutput) detail.appendChild(buildDetailSection(resultMeta.errorText ? 'Raw output' : 'Output', resultMeta.rawOutput, undefined, { collapsible: true }));
    return details;
  }

  // ── formatToolOutput ─────────────────────────────────────────────────────
  function formatToolOutput(result) {
    if (result == null) return '';
    if (typeof result !== 'string') { try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); } }
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

  // ── handleToolStart ──────────────────────────────────────────────────────
  function handleToolStart(ev) {
    var row = window.getOrCreateAssistantMessage(ev.runId);
    if (window.flushActivityNotes) window.flushActivityNotes(ev.runId, row);
    var tools = row.querySelector('.tool-calls');
    if (!tools) {
      var stream = window.ensureActivityStream ? window.ensureActivityStream(row) : row;
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      stream.appendChild(tools);
    }
    window.toolContainers.set(ev.runId, tools);
    var toolName = ev.toolName || '';
    if (!toolName) return;
    var args = ev.args || '';
    if (args === '{}' || args === 'undefined') args = '';
    var existing = window.toolCalls.get(ev.toolCallId);
    if (existing) {
      var rebuilt = buildToolRow({ toolName: toolName, args: args, phase: 'start' });
      rebuilt.id = existing.id || ('tool-' + ev.toolCallId);
      existing.replaceWith(rebuilt);
      window.toolCalls.set(ev.toolCallId, rebuilt);
      return;
    }
    var card = buildToolRow({ toolName: toolName, args: args, phase: 'start' });
    card.id = 'tool-' + ev.toolCallId;
    tools.appendChild(card);
    window.toolCalls.set(ev.toolCallId, card);
    window.scrollToBottom();
  }
  window.handleToolStart = handleToolStart;

  // ── renderToolHistory ────────────────────────────────────────────────────
  function renderToolHistory(row, tools) {
    if (!tools || !tools.length) return;
    var container = row.querySelector('.tool-calls');
    if (!container) {
      var stream = window.ensureActivityStream ? window.ensureActivityStream(row) : row;
      container = document.createElement('div');
      container.className = 'tool-calls';
      stream.appendChild(container);
    }
    window.toolContainers.set(row.getAttribute('data-run-id') || 'history-tools', container);
    tools.forEach(function (tool) {
      var toolName = tool.toolName || '';
      if (!toolName) return;
      var card = buildToolRow({ toolName: toolName, args: tool.args, updates: tool.updates, result: tool.result, isError: tool.isError, phase: 'result' });
      container.appendChild(card);
      if (tool.toolCallId) window.toolCalls.set(tool.toolCallId, card);
    });
    groupToolRows(container);
  }
  window.renderToolHistory = renderToolHistory;

  function renderToolHistoryItem(row, tool) {
    if (!row || !tool || !tool.toolName) return;
    var container = row.querySelector('.tool-calls');
    if (!container) {
      var stream = window.ensureActivityStream ? window.ensureActivityStream(row) : row;
      container = document.createElement('div');
      container.className = 'tool-calls';
      stream.appendChild(container);
    }
    var card = buildToolRow({ toolName: tool.toolName, args: tool.args, updates: tool.updates, result: tool.result, isError: tool.isError, phase: 'result' });
    container.appendChild(card);
    if (tool.toolCallId) window.toolCalls.set(tool.toolCallId, card);
    var runId = row.getAttribute('data-run-id') || 'history-tools';
    window.toolContainers.set(runId, container);
  }
  window.renderToolHistoryItem = renderToolHistoryItem;

  // ── handleToolUpdate ─────────────────────────────────────────────────────
  function handleToolUpdate(ev) {
    var card = window.toolCalls.get(ev.toolCallId);
    if (!card) return;
    var row = card.closest('.chat-row.assistant');
    var runId = row ? row.getAttribute('data-run-id') : '';
    if (runId && window.flushActivityNotes) window.flushActivityNotes(runId, row);
    var detail = card.querySelector('.tool-detail');
    if (!detail) return;
    var log = detail.querySelector('[data-section="log"]');
    if (!log) {
      log = buildDetailSection('Log', '');
      detail.appendChild(log);
    }
    var pre = log.querySelector('pre');
    if (pre) pre.textContent = (pre.textContent || '') + (ev.text || '');
    window.scrollToBottom();
  }
  window.handleToolUpdate = handleToolUpdate;

  // ── handleToolResult ────────────────────────────────────────────────────
  function handleToolResult(ev) {
    var card = window.toolCalls.get(ev.toolCallId);
    if (!card) return;
    var row = card.closest('.chat-row.assistant');
    var runId = row ? row.getAttribute('data-run-id') : '';
    if (runId && window.flushActivityNotes) window.flushActivityNotes(runId, row);
    var resultMeta = deriveResultMeta(ev.result, ev.isError);
    setToolRowStatus(card, resultMeta.isError ? 'error' : 'done');
    var out = resultMeta.rawOutput;
    if (out) {
      var detail = card.querySelector('.tool-detail');
        if (detail) {
          var errorSection = detail.querySelector('[data-section="error"]');
          if (resultMeta.errorText && !errorSection) {
            detail.insertBefore(buildDetailSection('Error', resultMeta.errorText, 'text', { collapsible: true, open: true }), detail.firstChild);
          }
          var fileSection = detail.querySelector('[data-section="file text"]');
          if (resultMeta.fileText && !fileSection) {
            detail.insertBefore(buildDetailSection('File text', resultMeta.fileText, inferLanguageFromPath(extractFilePath(parseArgsObject(card._toolArgs) || {})), { collapsible: true, open: false }), errorSection ? errorSection.nextSibling : detail.firstChild);
          }
          var section = detail.querySelector('[data-section="output"], [data-section="raw output"]');
          if (resultMeta.showRawOutput) {
            if (!section) {
              detail.appendChild(buildDetailSection(resultMeta.errorText ? 'Raw output' : 'Output', out, undefined, { collapsible: true }));
            } else {
              var label = section.querySelector('.code-editor-label');
              if (label) label.textContent = resultMeta.errorText ? 'Raw output' : 'Output';
              var code = section.querySelector('pre');
              if (code) {
                var isJson = false;
                var trimmed = out.trim();
                if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 2) {
                  try { JSON.parse(trimmed); isJson = true; } catch (e) {}
                }
                if (isJson) { code.innerHTML = window.syntaxHighlightJson(out); }
                else { code.innerHTML = window.simpleHighlight(out, 'javascript'); }
              }
            }
          } else if (section) {
            section.remove();
          }
          var summary = card.querySelector('.tool-row-summary');
          if (summary) {
          var existingBadge = summary.querySelector('.tool-summary-badge');
          if (existingBadge) existingBadge.remove();
          if (resultMeta.isError) {
            var errorBadge = document.createElement('span');
            errorBadge.className = 'tool-summary-badge error';
            errorBadge.textContent = 'Error';
            summary.insertBefore(errorBadge, summary.querySelector('.tool-chevron'));
          } else if (resultMeta.statusText) {
            var statusBadge = document.createElement('span');
            statusBadge.className = 'tool-summary-badge';
            statusBadge.textContent = resultMeta.statusText;
            summary.insertBefore(statusBadge, summary.querySelector('.tool-chevron'));
          }
        }
      }
    }
    window.scrollToBottom();
  }
  window.handleToolResult = handleToolResult;

  // ── Activity-stream config ───────────────────────────────────────────────
  var streamCfg = { layout: 'accordion', rail: true, dots: 'status' };
  window.streamCfg = streamCfg;

  function applyStreamConfig() {
    var b = document.body;
    b.classList.remove(
      'stream-layout-accordion', 'stream-layout-timeline', 'stream-layout-hybrid',
      'stream-rail', 'stream-dots-status', 'stream-dots-minimal'
    );
    b.classList.add('stream-layout-' + streamCfg.layout);
    if (streamCfg.rail) b.classList.add('stream-rail');
    b.classList.add('stream-dots-' + streamCfg.dots);
    if (window.syncActivityLayoutAllRows) window.syncActivityLayoutAllRows();
  }
  applyStreamConfig();
  window.applyStreamConfig = applyStreamConfig;

  var GROUPABLE_KINDS = { edit: 1, exec: 1, explore: 1, fetch: 1 };

  function classifyCommand(cmd) {
    var c = String(cmd || '').trim();
    for (var guard = 0; guard < 4; guard++) {
      var m = c.match(/^cd\s+[^;&|]+(?:&&|;)\s*(.*)$/);
      if (!m) break;
      c = m[1].trim();
    }
    var word = (c.match(/^[\w.\/-]+/) || [''])[0].replace(/^.*\//, '');
    if (/^(grep|rg|ag|ack|fd|find)$/.test(word)) return 'search';
    if (/^(ls|tree|du|exa|lsd)$/.test(word)) return 'list';
    if (/^(cat|head|tail|bat|less|more|stat|wc)$/.test(word)) return 'read';
    if (word === 'sed' && /\s-n\b/.test(c) && !/\s-i\b/.test(c)) return 'read';
    return 'command';
  }

  function activitySummaryLabel(rows) {
    var created = {}, edited = {}, explored = {};
    var searches = 0, lists = 0, commands = 0, webSearches = 0, calls = 0;
    rows.forEach(function (r) {
      var kind = r.getAttribute('data-kind');
      var verbEl = r.querySelector('.tool-verb');
      var verb = verbEl ? verbEl.textContent : '';
      var target = r.getAttribute('data-target') || '';
      if (kind === 'edit') {
        if (verb === 'Added') created[target] = 1;
        else edited[target] = 1;
      } else if (kind === 'explore') {
        if (verb === 'Read') explored[target] = 1;
        else if (verb === 'Listed') lists++;
        else searches++;
      } else if (kind === 'exec') {
        var cls = classifyCommand(target);
        if (cls === 'read') explored[target] = 1;
        else if (cls === 'search') searches++;
        else if (cls === 'list') lists++;
        else commands++;
      } else if (kind === 'fetch') { webSearches++; }
      else { calls++; }
    });
    var segs = [];
    function seg(count, cap, low, one, many) {
      if (!count) return;
      segs.push((segs.length === 0 ? cap : low) + ' ' + count + ' ' + (count === 1 ? one : many));
    }
    function size(obj) { return Object.keys(obj).length; }
    var createdCount = size(created);
    var editedCount = size(edited);
    var editedTotal = createdCount + editedCount;
    if (editedTotal) {
      if (createdCount && !editedCount) seg(createdCount, 'Added', 'added', 'file', 'files');
      else seg(editedTotal, 'Edited', 'edited', 'file', 'files');
    }
    var exploreBits = [];
    if (size(explored)) exploreBits.push(size(explored) + (size(explored) === 1 ? ' file' : ' files'));
    if (searches) exploreBits.push(searches + (searches === 1 ? ' search' : ' searches'));
    if (lists) exploreBits.push(lists + (lists === 1 ? ' list' : ' lists'));
    if (exploreBits.length) segs.push((segs.length === 0 ? 'Explored' : 'explored') + ' ' + exploreBits.join(', '));
    seg(commands, 'Ran', 'ran', 'command', 'commands');
    seg(webSearches, 'Searched web', 'searched web', 'time', 'times');
    seg(calls, 'Called', 'called', 'tool', 'tools');
    return segs.length ? segs.join(', ') : 'Tool activity';
  }

  function toolGroupKey(row) {
    if (!row || !row.classList || !row.classList.contains('tool-row')) return '';
    var kind = row.getAttribute('data-kind') || '';
    var verbEl = row.querySelector('.tool-verb');
    var verb = verbEl ? verbEl.textContent : '';
    var target = row.getAttribute('data-target') || '';
    if (kind === 'edit') return kind;
    if (kind === 'exec') return kind;
    if (kind === 'explore') return kind + '||' + verb;
    if (kind === 'fetch') return kind;
    return [kind, verb, target].join('||');
  }

  function groupToolRows(container) {
    if (!container) return;
    Array.prototype.slice.call(container.querySelectorAll(':scope > .tool-group')).forEach(function (group) {
      var body = group.querySelector('.tool-group-body');
      if (body) { while (body.firstChild) container.insertBefore(body.firstChild, group); }
      group.remove();
    });
    if (streamCfg.layout === 'timeline') return;
    var children = Array.prototype.slice.call(container.children);
    var runs = [];
    var current = [];

    function flushRun() {
      if (current.length > 1) runs.push(current.slice());
      current = [];
    }

    children.forEach(function (node) {
      var groupable = !!(node.classList && node.classList.contains('tool-row') &&
        !node.querySelector('.tool-row-status.running') &&
        GROUPABLE_KINDS[node.getAttribute('data-kind')]);
      if (!groupable) {
        flushRun();
        return;
      }
      if (!current.length) {
        current.push(node);
        return;
      }
      if (toolGroupKey(current[0]) === toolGroupKey(node)) {
        current.push(node);
        return;
      }
      flushRun();
      current.push(node);
    });
    flushRun();

    runs.forEach(function (groupable) {
      var hasError = groupable.some(function (r) { return r.querySelector('.tool-row-status.error'); });
      var group = document.createElement('details');
      group.className = 'tool-group';
      var summary = document.createElement('summary');
      summary.className = 'tool-row-summary tool-group-summary';
      var groupStatus = document.createElement('span');
      groupStatus.className = 'tool-row-status ' + (hasError ? 'error' : 'done');
      groupStatus.setAttribute('aria-hidden', 'true');
      groupStatus.innerHTML = '<span class="codicon codicon-' + (groupable[0].getAttribute('data-icon') || 'layers') + ' tool-status-icon" aria-hidden="true"></span>';
      summary.appendChild(groupStatus);
      var groupTitle = document.createElement('span');
      groupTitle.className = 'tool-group-title';
      groupTitle.textContent = activitySummaryLabel(groupable);
      summary.appendChild(groupTitle);
      appendChevron(summary);
      var body = document.createElement('div');
      body.className = 'tool-group-body';
      container.insertBefore(group, groupable[0]);
      group.appendChild(summary);
      group.appendChild(body);
      groupable.forEach(function (r) { r.open = false; body.appendChild(r); });
    });
  }
  window.groupToolRows = groupToolRows;

  // ── MutationObserver: re-attach tool containers ──────────────────────────
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.removedNodes.length; j++) {
        var node = m.removedNodes[j];
        if (node.nodeType === 1 && node.classList && node.classList.contains('tool-calls')) {
          window.activeRuns.forEach(function (row, runId) {
            if (!row.querySelector('.tool-calls') && window.toolContainers.has(runId)) {
              row.appendChild(window.toolContainers.get(runId));
            }
          });
        }
      }
    }
  });
  var messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) observer.observe(messagesDiv, { childList: true, subtree: true });

})();
