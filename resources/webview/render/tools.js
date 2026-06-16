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

  function shellCommandText(obj, args) {
    var value = getFirstString(obj, ['command', 'cmd', 'script']);
    if (value) return value;
    if (Array.isArray(obj.command)) return obj.command.join(' ');
    if (Array.isArray(obj.cmd)) return obj.cmd.join(' ');
    if (Array.isArray(obj.args)) return obj.args.join(' ');
    var raw = stringifyArgs(args).trim();
    if (!raw || raw === '{}' || raw === 'undefined') return '';
    return raw;
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

  function patchFilePath(patch) {
    var m = String(patch || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/) ||
            String(patch || '').match(/\+\+\+ [ab]\/(.+)/);
    return m ? m[1].trim() : '';
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
    var meta = { kind: 'other', verb: raw, target: '', fullTarget: '', filePath: file || '', plus: 0, minus: 0, mono: false, icon: 'tools' };

    if (/(^|_)(exec|bash|shell|terminal|process)/.test(name) || /run_command|run_terminal/.test(name) || name === 'run') {
      meta.kind = 'exec'; meta.mono = true;
      meta.verb = 'Ran';
      meta.fullTarget = shellCommandText(obj, args);
      meta.target = meta.fullTarget || 'command';
    } else if (/apply_patch|apply_diff|(^|_)patch/.test(name)) {
      meta.kind = 'edit'; meta.verb = 'Edited';
      var patchText = String(obj.patch || obj.diff || obj.input || stringifyArgs(args));
      var stat = diffStatFromPatch(patchText);
      meta.plus = stat.plus; meta.minus = stat.minus;
      meta.filePath = file || patchFilePath(patchText);
      meta.target = baseName(meta.filePath) || patchFileName(patchText) || 'patch';
    } else if (/str_replace|multi_edit|(^|_)edit|(^|_)replace/.test(name)) {
      meta.kind = 'edit'; meta.verb = 'Edited';
      meta.filePath = file || '';
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
      meta.filePath = file || '';
      meta.target = baseName(file) || 'file';
      meta.plus = lineCount(obj.content || obj.text || '');
    } else if (/fetch|browser|(^|_)web|http|curl|download/.test(name)) {
      meta.kind = 'fetch'; meta.verb = 'Fetched';
      meta.target = String(obj.url || obj.query || truncateArgs(stringifyArgs(args)));
    } else if (/(^|_)(read|cat|open|view)/.test(name)) {
      meta.kind = 'explore'; meta.verb = 'Read';
      meta.filePath = file || '';
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
    if (opts.collapsible) section.open = opts.open === true;

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
    body.appendChild(buildLineNumberGutter(text));
    var code = document.createElement('pre');
    code.className = 'code-editor-code';
    if (isJson) { code.innerHTML = window.syntaxHighlightJson(text); }
    else if (label === 'Log') { code.textContent = text; }
    else { code.innerHTML = window.simpleHighlight(text, lang || 'text'); }
    body.appendChild(code);

    editor.appendChild(header);
    editor.appendChild(body);
    if (!opts.collapsible) section.appendChild(editor);
    return section;
  }

  function lineNumberCount(text) {
    var value = String(text == null ? '' : text);
    if (!value) return 1;
    return value.split('\n').length;
  }

  function buildLineNumberGutter(text) {
    var gutter = document.createElement('div');
    gutter.className = 'code-editor-lines';
    gutter.setAttribute('aria-hidden', 'true');
    var count = lineNumberCount(text);
    for (var i = 1; i <= count; i++) {
      var num = document.createElement('span');
      num.className = 'code-editor-line-num';
      num.textContent = String(i);
      gutter.appendChild(num);
    }
    return gutter;
  }

  function refreshCodeEditorLines(sectionOrBody, text) {
    if (!sectionOrBody) return;
    var body = sectionOrBody.classList && sectionOrBody.classList.contains('code-editor-body')
      ? sectionOrBody
      : sectionOrBody.querySelector('.code-editor-body');
    if (!body) return;
    var old = body.querySelector('.code-editor-lines');
    var next = buildLineNumberGutter(text);
    if (old) old.replaceWith(next);
    else body.insertBefore(next, body.firstChild);
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

    if (changes.length === 1) section.classList.add('tool-edit-previews-inline');
    else {
      var title = document.createElement('div');
      title.className = 'tool-edit-previews-title';
      title.textContent = 'Changes (' + changes.length + ')';
      section.appendChild(title);
    }

    changes.forEach(function (change, index) {
      var inlineSingle = changes.length === 1;
      var wrapper = inlineSingle ? document.createElement('div') : document.createElement('details');
      wrapper.className = 'tool-edit-preview' + (inlineSingle ? ' tool-edit-preview-inline' : '');
      if (!inlineSingle) wrapper.open = false;

      var summary = inlineSingle ? null : document.createElement('summary');
      if (summary) summary.className = 'tool-edit-preview-summary';

      if (summary) {
        var fileEl = document.createElement('span');
        fileEl.className = 'tool-edit-preview-file';
        fileEl.textContent = change.path || ('edit-' + (index + 1));
        fileEl.title = change.path || '';
        summary.appendChild(fileEl);
      }

      if (summary) {
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
      }

      var body = document.createElement('div');
      body.className = 'tool-edit-preview-body';
      if (inlineSingle) section._ioTarget = body;

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
    if (meta.filePath) details.setAttribute('data-file', meta.filePath);
    if (meta.fullTarget) details.setAttribute('data-full-target', meta.fullTarget);
    details.setAttribute('data-icon', meta.icon);
    details.setAttribute('data-tool-name', meta.verb);
    if (meta.kind === 'exec') details.classList.add('tool-row-pill');
    if (meta.kind === 'explore' && meta.verb === 'Read') details.classList.add('tool-row-pill');
    if (meta.kind === 'fetch') details.classList.add('tool-row-pill');
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
      var target = document.createElement(meta.filePath ? 'a' : 'span');
      target.className = 'tool-target' + (meta.mono ? ' mono' : '') + (meta.filePath ? ' file-link' : '');
      target.textContent = meta.target;
      if (meta.filePath) {
        target.href = '#';
        target.setAttribute('data-file', meta.filePath);
        target.title = meta.filePath;
      }
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
    var shellLang = meta.kind === 'exec' ? 'sh' : undefined;
    if (meta.kind === 'exec' && meta.fullTarget) detail.appendChild(buildDetailSection('Command', meta.fullTarget, shellLang, { collapsible: true }));
    var previewBodies = editPreview ? editPreview.querySelectorAll('.tool-edit-preview-body') : [];
    var ioTarget = (previewBodies.length === 1) ? previewBodies[0] : detail;
    if (argsText && argsText !== '{}') ioTarget.appendChild(buildDetailSection('Input', argsText, shellLang, { collapsible: true }));
    if (tool.updates) ioTarget.appendChild(buildDetailSection('Log', tool.updates, shellLang, { collapsible: true }));
    if (tool.result && resultMeta.showRawOutput) ioTarget.appendChild(buildDetailSection(resultMeta.errorText ? 'Raw output' : 'Output', resultMeta.rawOutput, shellLang, { collapsible: true }));
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
    if (window.activityUsesUnifiedTimeline && window.activityUsesUnifiedTimeline() && window.ensureActivityThoughtBlock) {
      window.ensureActivityThoughtBlock(ev.runId, row);
    }
    // A tool fired: any thinking that resumes after this opens a new reasoning
    // segment, so thought/tool order stays chronological in accordion mode.
    if (window.reasoningInterrupted) window.reasoningInterrupted.add(ev.runId);
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
      groupToolRows(rebuilt.closest('.tool-calls'));
      return;
    }
    var card = buildToolRow({ toolName: toolName, args: args, phase: 'start' });
    card.id = 'tool-' + ev.toolCallId;
    tools.appendChild(card);
    window.toolCalls.set(ev.toolCallId, card);
    groupToolRows(tools);
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
    if (window.activityUsesUnifiedTimeline && window.activityUsesUnifiedTimeline() && window.ensureActivityThoughtBlock) {
      window.ensureActivityThoughtBlock(row.getAttribute('data-run-id') || 'history-tools', row);
    }
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
    if (window.activityUsesUnifiedTimeline && window.activityUsesUnifiedTimeline() && window.ensureActivityThoughtBlock) {
      window.ensureActivityThoughtBlock(row.getAttribute('data-run-id') || 'history-tools', row);
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
      var logPreviewBodies = detail.querySelectorAll('.tool-edit-preview-body');
      var logTarget = (logPreviewBodies.length === 1) ? logPreviewBodies[0] : detail;
      logTarget.appendChild(log);
    }
    var pre = log.querySelector('pre');
    if (pre) {
      pre.textContent = (pre.textContent || '') + (ev.text || '');
      refreshCodeEditorLines(log, pre.textContent || '');
    }
    if (card.parentNode) groupToolRows(card.closest('.tool-calls'));
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
              var outPreviewBodies = detail.querySelectorAll('.tool-edit-preview-body');
              var outTarget = (outPreviewBodies.length === 1) ? outPreviewBodies[0] : detail;
              outTarget.appendChild(buildDetailSection(resultMeta.errorText ? 'Raw output' : 'Output', out, undefined, { collapsible: true }));
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
                else { code.innerHTML = window.simpleHighlight(out, card.getAttribute('data-kind') === 'exec' ? 'sh' : 'text'); }
                refreshCodeEditorLines(section, out);
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
    if (card.parentNode) groupToolRows(card.closest('.tool-calls'));
    window.scrollToBottom();
  }
  window.handleToolResult = handleToolResult;

  // ── Activity-stream config ───────────────────────────────────────────────
  function normalizeActivityLayout(layout) {
    return layout === 'timeline' ? 'timeline' : 'accordion';
  }
  window.normalizeActivityLayout = normalizeActivityLayout;

  var streamCfg = { layout: 'accordion', rail: true, dots: 'status', condensed: true };
  window.streamCfg = streamCfg;

  function applyStreamConfig() {
    var b = document.body;
    streamCfg.layout = normalizeActivityLayout(streamCfg.layout);
    b.classList.remove(
      'stream-layout-accordion', 'stream-layout-timeline',
      'stream-rail', 'stream-dots-status', 'stream-dots-minimal'
    );
    b.classList.add('stream-layout-' + streamCfg.layout);
    if (streamCfg.layout === 'timeline') {
      if (streamCfg.rail) b.classList.add('stream-rail');
      b.classList.add('stream-dots-' + streamCfg.dots);
    }
    if (window.syncActivityLayoutAllRows) window.syncActivityLayoutAllRows();
    if (streamCfg.layout === 'timeline') {
      if (window.ensureTimelineActivityModule) window.ensureTimelineActivityModule();
      else if (window.syncTimelineStickyUserRows) window.syncTimelineStickyUserRows();
    } else if (window.clearTimelineStickyUserRows) {
      window.clearTimelineStickyUserRows();
    }
    if (GROUPABLE_KINDS) {
      document.querySelectorAll('#chat-messages .tool-calls').forEach(function (container) {
        groupToolRows(container);
      });
    }
  }
  applyStreamConfig();
  window.applyStreamConfig = applyStreamConfig;

  var GROUPABLE_KINDS = { edit: 1, exec: 1, explore: 1, fetch: 1 };

  function classifyShellActions(command) {
    var counts = { cd: 0, list: 0, search: 0, read: 0, command: 0 };
    var text = String(command || '').trim();
    if (!text) return counts;
    text.split(/\s*(?:&&|\|\||;)\s*/).forEach(function (part) {
      var p = String(part || '').trim();
      if (!p) return;
      if (/^for\s+/.test(p) || /^while\s+/.test(p) || /^if\s+/.test(p)) {
        counts.command++;
        return;
      }
      var m = p.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?([\w.\/-]+)/);
      var word = (m ? m[1] : '').replace(/^.*\//, '');
      if (!word) return;
      if (word === 'cd' || word === 'pushd' || word === 'popd') counts.cd++;
      else if (/^(ls|tree|du|exa|lsd)$/.test(word)) counts.list++;
      else if (/^(grep|rg|ag|ack|fd|find)$/.test(word)) counts.search++;
      else if (/^(cat|head|tail|bat|less|more|stat|wc)$/.test(word)) counts.read++;
      else if (word === 'sed' && /\s-n\b/.test(p) && !/\s-i\b/.test(p)) counts.read++;
      else counts.command++;
    });
    return counts;
  }

  function shellCommandWord(command) {
    var text = String(command || '').trim();
    var fallback = '';
    if (!text) return '';
    var parts = text.split(/\s*(?:&&|\|\||;)\s*/);
    for (var i = 0; i < parts.length; i++) {
      var p = String(parts[i] || '').trim();
      if (!p || /^for\s+|^while\s+|^if\s+/.test(p)) continue;
      var m = p.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?([\w.\/-]+)/);
      var word = (m ? m[1] : '').replace(/^.*\//, '');
      if (!word) continue;
      if (!fallback) fallback = word;
      if (word !== 'cd' && word !== 'pushd' && word !== 'popd') return word;
    }
    return fallback;
  }

  function activitySummaryLabel(rows) {
    var created = {}, edited = {}, explored = {};
    var searches = 0, lists = 0, reads = 0, cd = 0, commands = 0, webSearches = 0, calls = 0;
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
        var shell = classifyShellActions(r.getAttribute('data-full-target') || target);
        cd += shell.cd;
        lists += shell.list;
        searches += shell.search;
        reads += shell.read;
        commands += shell.command;
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
    var exploredCount = size(explored);
    if (exploredCount) seg(exploredCount, 'Read', 'read', 'file', 'files');
    seg(searches, 'Searched code', 'searched code', 'time', 'times');
    seg(lists, 'Listed files', 'listed files', 'time', 'times');
    seg(reads, 'Read files', 'read files', 'time', 'times');
    seg(cd, 'Changed directory', 'changed directory', 'time', 'times');
    seg(commands, 'Ran', 'ran', 'other command', 'other commands');
    seg(webSearches, 'Searched web', 'searched web', 'time', 'times');
    seg(calls, 'Called', 'called', 'tool', 'tools');
    return segs.length ? segs.join(', ') : 'Tool activity';
  }
  window.activitySummaryLabel = activitySummaryLabel;

  function setReasoningActivitySummary(reasoning, text) {
    if (!reasoning) return;
    var summary = reasoning.querySelector(':scope > summary');
    if (!summary) return;
    var subline = summary.querySelector('.reasoning-activity-summary');
    if (!subline) {
      var label = summary.querySelector('.reasoning-label');
      var wrapper = summary.querySelector('.reasoning-summary-text');
      if (!wrapper) {
        wrapper = document.createElement('span');
        wrapper.className = 'reasoning-summary-text';
        if (label) {
          label.parentNode.insertBefore(wrapper, label);
          wrapper.appendChild(label);
        } else {
          summary.insertBefore(wrapper, summary.lastChild);
        }
      }
      subline = document.createElement('span');
      subline.className = 'reasoning-activity-summary';
      wrapper.appendChild(subline);
    }
    subline.textContent = text || '';
  }

  function directToolRows(node) {
    if (!node || !node.classList) return [];
    if (node.classList.contains('tool-row')) return [node];
    if (node.classList.contains('tool-group')) {
      return Array.prototype.slice.call(node.querySelectorAll('.tool-group-body > .tool-row'));
    }
    return [];
  }

  function syncReasoningActivitySummaries(container) {
    if (!container) return;
    Array.prototype.slice.call(container.querySelectorAll(':scope > .reasoning-disclosure')).forEach(function (reasoning) {
      var rows = [];
      Array.prototype.slice.call(reasoning.children).forEach(function (node) {
        rows = rows.concat(directToolRows(node));
      });
      setReasoningActivitySummary(reasoning, rows.length ? activitySummaryLabel(rows) : '');
    });
  }

  function directActivityNodes(container) {
    return Array.prototype.slice.call(container.children).filter(function (node) {
      return node.classList && (
        node.classList.contains('tool-row') ||
        node.classList.contains('tool-group') ||
        node.classList.contains('reasoning-disclosure') ||
        (node.classList.contains('reasoning-content') && node.classList.contains('activity-thought-chunk'))
      );
    });
  }

  function createAccordionThoughtRoot(container) {
    var block = document.createElement('details');
    block.className = 'reasoning-disclosure accordion-root-thought';
    block.open = false;
    var summary = document.createElement('summary');
    if (window.summaryHtml) summary.innerHTML = window.summaryHtml('Thought · ~0 tokens', { showBar: false });
    else summary.textContent = 'Thought · ~0 tokens';
    block.appendChild(summary);
    container.insertBefore(block, container.firstChild);
    return block;
  }

  function directReasonings(container) {
    return Array.prototype.slice.call(container.querySelectorAll(':scope > .reasoning-disclosure'));
  }

  function liftAccordionActivityChildren(container) {
    if (!container) return;
    directReasonings(container).forEach(function (reasoning) {
      if (!reasoning.classList.contains('accordion-root-thought')) return;
      var insertAfter = reasoning;
      Array.prototype.slice.call(reasoning.children).forEach(function (child) {
        if (!child.classList) return;
        if (child.tagName && child.tagName.toLowerCase() === 'summary') return;
        if (
          child.classList.contains('tool-row') ||
          child.classList.contains('tool-group') ||
          (child.classList.contains('reasoning-content') && child.classList.contains('activity-thought-chunk'))
        ) {
          container.insertBefore(child, insertAfter.nextSibling);
          insertAfter = child;
        }
      });
      reasoning.remove();
    });
  }

  function mergeAccordionThoughts(container) {
    if (!container || streamCfg.layout !== 'accordion') return;
    var nodes = directActivityNodes(container).filter(function (node) {
      return !(node.classList && node.classList.contains('reasoning-disclosure') && node.classList.contains('thinking'));
    });
    if (!nodes.length) return;
    var root = createAccordionThoughtRoot(container);
    container.insertBefore(root, nodes[0]);
    root.classList.add('accordion-root-thought');
    root.open = false;

    nodes.forEach(function (node) {
      if (!node.classList) return;
      if (node.classList.contains('reasoning-disclosure')) {
        var content = node.querySelector(':scope > .reasoning-content');
        if (content && content.textContent.trim()) {
          content.classList.add('activity-thought-chunk');
          root.appendChild(content);
        }
        node.remove();
        return;
      }
      if (
        node.classList.contains('tool-row') ||
        node.classList.contains('tool-group') ||
        (node.classList.contains('reasoning-content') && node.classList.contains('activity-thought-chunk'))
      ) {
        root.appendChild(node);
      }
    });

    var rawText = Array.prototype.slice.call(root.querySelectorAll(':scope > .activity-thought-chunk'))
      .map(function (chunk) { return chunk.textContent || ''; })
      .join('\n\n');
    var label = 'Thought · ~' + (rawText.trim() ? window.approxTokens(rawText).toLocaleString() : '0') + ' tokens';
    var labelEl = root.querySelector(':scope > summary .reasoning-label');
    if (labelEl) labelEl.textContent = label;
    else {
      var summary = root.querySelector(':scope > summary');
      if (summary) summary.textContent = label;
    }
    var rows = [];
    Array.prototype.slice.call(root.children).forEach(function (node) {
      rows = rows.concat(directToolRows(node));
    });
    setReasoningActivitySummary(root, rows.length ? activitySummaryLabel(rows) : '');
  }

  function ungroupDirectToolGroups(container) {
    Array.prototype.slice.call(container.querySelectorAll(':scope > .tool-group')).forEach(function (group) {
      var body = group.querySelector('.tool-group-body');
      if (body) { while (body.firstChild) container.insertBefore(body.firstChild, group); }
      group.remove();
    });
  }

  function groupRowsInContainer(container) {
    ungroupDirectToolGroups(container);
    var children = Array.prototype.slice.call(container.children);
    var runs = [];
    var current = [];

    function flushRun() {
      if (current.length > 1) runs.push(current.slice());
      current = [];
    }

    children.forEach(function (node) {
      var groupable = !!(node.classList && node.classList.contains('tool-row') &&
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
      if (streamCfg.condensed && groupable[0].getAttribute('data-kind') === 'edit') {
        buildCondensedFileGroup(groupable, container);
        return;
      }
      var hasError = groupable.some(function (r) { return r.querySelector('.tool-row-status.error'); });
      var hasRunning = groupable.some(function (r) { return r.querySelector('.tool-row-status.running'); });
      var group = document.createElement('details');
      group.className = 'tool-group';
      var summary = document.createElement('summary');
      summary.className = 'tool-row-summary tool-group-summary';
      var groupStatus = document.createElement('span');
      groupStatus.className = 'tool-row-status ' + (hasError ? 'error' : (hasRunning ? 'running' : 'done'));
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

  function toolGroupKey(row) {
    if (!row || !row.classList || !row.classList.contains('tool-row')) return '';
    var kind = row.getAttribute('data-kind') || '';
    var verbEl = row.querySelector('.tool-verb');
    var verb = verbEl ? verbEl.textContent : '';
    var target = row.getAttribute('data-target') || '';
    if (streamCfg.condensed) {
      if (kind === 'edit') return 'file||' + target;
      if (kind === 'exec') return kind + '||' + shellCommandWord(row.getAttribute('data-full-target') || target);
      if (kind === 'explore') return kind + '||' + verb;
      if (kind === 'fetch') return kind;
      return kind + '||' + verb;
    }
    if (kind === 'edit') return kind;
    if (kind === 'exec') return kind + '||' + shellCommandWord(row.getAttribute('data-full-target') || target);
    if (kind === 'explore') return kind + '||' + verb;
    if (kind === 'fetch') return kind;
    return [kind, verb, target].join('||');
  }

  function extractEditFilePath(row) {
    var args = row._toolArgs;
    if (!args) return '';
    var obj = parseArgsObject(args);
    return extractFilePath(obj) || row.getAttribute('data-target') || '';
  }

  function buildCondensedFileGroup(rows, container) {
    var filePath = extractEditFilePath(rows[0]) || 'file';
    var fileName = baseName(filePath);
    var totalPlus = 0, totalMinus = 0;
    var hasError = false;
    var hasRunning = false;
    rows.forEach(function (r) {
      if (r.querySelector('.tool-row-status.error')) hasError = true;
      if (r.querySelector('.tool-row-status.running')) hasRunning = true;
      var plusEl = r.querySelector('.diff-plus');
      var minusEl = r.querySelector('.diff-minus');
      if (plusEl) totalPlus += parseInt(plusEl.textContent.replace('+', ''), 10) || 0;
      if (minusEl) totalMinus += parseInt(minusEl.textContent.replace('-', ''), 10) || 0;
    });
    var verbEl = rows[0].querySelector('.tool-verb');
    var verb = verbEl ? verbEl.textContent : 'Edited';
    var group = document.createElement('details');
    group.className = 'tool-group file-group';
    group.setAttribute('data-file', filePath);
    var summary = document.createElement('summary');
    summary.className = 'tool-row-summary tool-group-summary file-group-summary';
    var statusEl = document.createElement('span');
    statusEl.className = 'tool-row-status ' + (hasError ? 'error' : (hasRunning ? 'running' : 'done'));
    statusEl.setAttribute('aria-hidden', 'true');
    var icon = rows[0].getAttribute('data-icon') || 'edit';
    statusEl.innerHTML = '<span class="codicon codicon-' + icon + ' tool-status-icon" aria-hidden="true"></span>';
    summary.appendChild(statusEl);
    var verbSummary = document.createElement('span');
    verbSummary.className = 'tool-verb';
    verbSummary.textContent = verb;
    summary.appendChild(verbSummary);
    var fileEl = document.createElement('a');
    fileEl.className = 'file-group-name file-link';
    fileEl.textContent = fileName;
    fileEl.href = '#';
    fileEl.setAttribute('data-file', filePath);
    fileEl.title = filePath;
    summary.appendChild(fileEl);
    var count = rows.length;
    if (count > 1) {
      var badge = document.createElement('span');
      badge.className = 'file-group-count';
      badge.textContent = count + ' edits';
      summary.appendChild(badge);
    }
    if (totalPlus || totalMinus) {
      var diffEl = document.createElement('span');
      diffEl.className = 'tool-diff';
      if (totalPlus) {
        var plus = document.createElement('span');
        plus.className = 'diff-plus';
        plus.textContent = '+' + totalPlus;
        diffEl.appendChild(plus);
      }
      if (totalMinus) {
        var minus = document.createElement('span');
        minus.className = 'diff-minus';
        minus.textContent = '-' + totalMinus;
        diffEl.appendChild(minus);
      }
      summary.appendChild(diffEl);
    }
    appendChevron(summary);
    var body = document.createElement('div');
    body.className = 'tool-group-body';
    container.insertBefore(group, rows[0]);
    group.appendChild(summary);
    group.appendChild(body);
    rows.forEach(function (r) { r.open = false; body.appendChild(r); });
    return group;
  }

  function groupToolRows(container) {
    if (!container) return;
    if (streamCfg.layout === 'accordion') liftAccordionActivityChildren(container);
    ungroupDirectToolGroups(container);
    // Reasoning disclosures and tool rows stay flat siblings in arrival order, so
    // the stream reads chronologically: thought, its tools, next thought, its
    // tools. (Reasoning is segmented at tool boundaries in reasoning.js.) Tools are
    // never nested inside a thought disclosure — that buried/segregated them.
    groupRowsInContainer(container);
    mergeAccordionThoughts(container);
    syncReasoningActivitySummaries(container);
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
