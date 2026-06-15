/* ==========================================================================
   helpers.js — Shared utilities for chat-stream modules
   ========================================================================== */
(function () {
  'use strict';

  // ── HTML escaping ────────────────────────────────────────────────────────────
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  window.escapeHtml = escapeHtml;

  // ── Simple syntax highlighter ───────────────────────────────────────────────
  function simpleHighlight(code, lang) {
    var tokens = [];
    var pos = 0;
    var rules = [
      { re: /\/\/.*$/gm, cls: 'cm' },
      { re: /\/\*[\s\S]*?\*\//g, cls: 'cm' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, cls: 'st' },
      { re: /\b(function|return|if|else|for|while|class|const|let|var|import|export|from|default|async|await|try|catch|throw|new|this|typeof|instanceof|switch|case|break|continue|do|in|of|void|delete|yield|static|extends|super|def|print|self|None|True|False|raise|except|finally|pass|lambda|global|nonlocal|assert|del|elif|as|with)\b/g, cls: 'kw' },
      { re: /\b\d+\.?\d*(?:e[+-]?\d+)?\b/g, cls: 'nu' },
      { re: /\b(true|false|null|undefined|None|True|False)\b/g, cls: 'bl' },
      { re: /\b([A-Z][a-zA-Z0-9_]*)\b/g, cls: 'ty' },
      { re: /\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, cls: 'fn' },
    ];
    var result = '';
    var remaining = code;
    while (remaining.length > 0) {
      var best = null;
      var bestIdx = remaining.length;
      var bestCls = '';
      for (var i = 0; i < rules.length; i++) {
        rules[i].re.lastIndex = 0;
        var m = rules[i].re.exec(remaining);
        if (m && m.index < bestIdx) {
          best = m;
          bestIdx = m.index;
          bestCls = rules[i].cls;
        }
      }
      if (best) {
        result += escapeHtml(remaining.substring(0, bestIdx));
        result += '<span class="hl-' + bestCls + '">' + escapeHtml(best[0]) + '</span>';
        remaining = remaining.substring(bestIdx + best[0].length);
      } else {
        result += escapeHtml(remaining);
        break;
      }
    }
    return result;
  }
  window.simpleHighlight = simpleHighlight;

  // ── Syntax-highlight JSON ───────────────────────────────────────────────────
  function syntaxHighlightJson(json) {
    return escapeHtml(json)
      .replace(/&quot;([^&]*?)&quot;\s*:/g, '<span class="json-key">&quot;$1&quot;</span>:')
      .replace(/:\s*&quot;([^&]*?)&quot;/g, ': <span class="json-string">&quot;$1&quot;</span>')
      .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
  }
  window.syntaxHighlightJson = syntaxHighlightJson;

  // ── Approximate token count ───────────────────────────────────────────────
  function approxTokens(text) { return Math.max(1, Math.round((text || '').length / 4)); }
  window.approxTokens = approxTokens;

  // ── Markdown rendering ──────────────────────────────────────────────────────
  var md = { render: function (t) { return escapeHtml(t).replace(/\n/g, '<br>'); } };
  if (window.markdownit) {
    md = window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
      highlight: function (str, lang) {
        var cleanLang = (lang || 'CODE').toUpperCase();
        return '<div class="code-editor">' +
          '<div class="code-editor-header">' +
            '<span class="code-editor-lang">' + escapeHtml(cleanLang) + '</span>' +
          '</div>' +
          '<div class="code-editor-body">' +
            '<pre class="code-editor-code"><code class="language-' + escapeHtml(lang || '') + '">' + simpleHighlight(str, lang) + '</code></pre>' +
          '</div>' +
        '</div>';
      }
    });
  }

  /** Post-process HTML to turn file paths into clickable links. */
  function linkifyFilePaths(html) {
    var pathRe = /(?<!["'=\w])(\.\.?\/[\w.\-\/]+|[~\/]\w[\w.\-\/]*\.\w{1,10}|(?:[\w]+\.)+[\w]{1,10})(?::\d+){0,2}(?!["'<>\w])/g;
    var seen = new Set();
    return html.replace(pathRe, function (match) {
      if (seen.has(match)) return match;
      seen.add(match);
      if (!match.includes('/') && !match.startsWith('.') && !match.startsWith('~')) return match;
      if (!match.match(/\.[a-z]{1,10}(?::\d+){0,2}$/i)) return match;
      return '<span class="file-link" data-file="' + escapeHtml(match) + '" title="Open ' + escapeHtml(match) + '">' + escapeHtml(match) + '</span>';
    });
  }

  function renderMarkdown(text) {
    try {
      var t = String(text || '').trim();
      if ((t[0] === '{' || t[0] === '[') && t.length > 2) {
        try {
          var parsed = JSON.parse(t);
          if (parsed && typeof parsed === 'object') {
            return '<pre class="msg-json">' + syntaxHighlightJson(JSON.stringify(parsed, null, 2)) + '</pre>';
          }
        } catch (e) { /* not pure JSON — fall through to markdown */ }
      }
      var html = md.render(text || '');
      return linkifyFilePaths(html);
    } catch (e) { return escapeHtml(text || ''); }
  }
  window.renderMarkdown = renderMarkdown;

  // ── Format thinking content ──────────────────────────────────────────────────
  function formatThinkingContent(text) {
    if (!text) return '';
    var trimmed = text.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !trimmed.includes('\n')) {
      try {
        var obj = JSON.parse(trimmed);
        return '<pre class="thinking-json">' + syntaxHighlightJson(JSON.stringify(obj, null, 2)) + '</pre>';
      } catch (e) { /* fall through */ }
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        var obj2 = JSON.parse(trimmed);
        return '<pre class="thinking-json">' + syntaxHighlightJson(JSON.stringify(obj2, null, 2)) + '</pre>';
      } catch (e) { /* fall through */ }
    }
    return '<div class="thinking-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
  }
  window.formatThinkingContent = formatThinkingContent;

  // ── Scroll helpers ──────────────────────────────────────────────────────────
  var messagesDiv_h = document.getElementById('chat-messages');
  var scrollRequested_h = false;
  var scrollForceRequested_h = false;

  function isNearBottom() {
    if (!messagesDiv_h) return true;
    var threshold = 80;
    return messagesDiv_h.scrollHeight - messagesDiv_h.scrollTop - messagesDiv_h.clientHeight < threshold;
  }

  function requestScroll(force) {
    if (force) scrollForceRequested_h = true;
    if (scrollRequested_h) return;
    scrollRequested_h = true;
    requestAnimationFrame(function () {
      scrollRequested_h = false;
      var force = scrollForceRequested_h;
      scrollForceRequested_h = false;
      if (!messagesDiv_h) return;
      if (force) { window.userScrollSticky = true; }
      if (window.userScrollSticky) {
        window.isProgrammaticScroll = true;
        messagesDiv_h.scrollTop = messagesDiv_h.scrollHeight;
      }
    });
  }

  function scrollToBottom() {
    requestScroll(false);
  }
  window.scrollToBottom = scrollToBottom;

  function forceScrollToBottom() {
    requestScroll(true);
  }
  window.forceScrollToBottom = forceScrollToBottom;

})();
