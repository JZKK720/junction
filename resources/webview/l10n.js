(function () {
  'use strict';

  var bundle = window.JUNCTION_L10N || {};
  var locale = String(bundle.locale || document.documentElement.lang || 'en').toLowerCase();

  function format(template, values) {
    if (!values) return template;
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : _;
    });
  }

  function t(key, fallback, values) {
    var text = Object.prototype.hasOwnProperty.call(bundle, key) ? bundle[key] : (fallback || key);
    return format(text, values);
  }

  function applyText(selector, key, fallback) {
    var el = document.querySelector(selector);
    if (el) el.textContent = t(key, fallback);
  }

  function applyAttr(selector, attr, key, fallback) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute(attr, t(key, fallback));
  }

  function applyMarked(root) {
    (root || document).querySelectorAll('[data-l10n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-l10n'), el.textContent || '');
    });
    (root || document).querySelectorAll('[data-l10n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-l10n-title'), el.getAttribute('title') || ''));
    });
    (root || document).querySelectorAll('[data-l10n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-l10n-placeholder'), el.getAttribute('placeholder') || ''));
    });
    (root || document).querySelectorAll('[data-l10n-aria-label]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-l10n-aria-label'), el.getAttribute('aria-label') || ''));
    });
  }

  function applyStaticChrome() {
    document.documentElement.lang = locale;
    document.body.classList.toggle('locale-cjk', /^zh(?:-|$)|^ja(?:-|$)|^ko(?:-|$)/.test(locale));
    document.body.classList.toggle('locale-devanagari', /^hi(?:-|$)|^mr(?:-|$)|^ne(?:-|$)/.test(locale));
    applyText('#startup-start-prompt', 'pushAnyToStart', 'push any to start');
    applyText('#session-list-header .title', 'chats', 'Chats');
    applyText('#chat-scope-label', 'thisFolder', 'This folder');
    applyText('.new-thread-label', 'newThread', 'New thread');
    applyAttr('#chat-scope', 'title', 'filterChats', 'Filter chats');
    applyAttr('#btn-new-chat', 'title', 'newThread', 'New thread');
    applyAttr('#session-list-input', 'placeholder', 'newChatPlaceholder', 'Type a message to start a new chat...');
    applyAttr('#btn-back', 'title', 'backToChats', 'Back to chats');
    applyAttr('#chat-title', 'title', 'clickToRename', 'Click to rename');
    applyAttr('#btn-task-history', 'title', 'taskHistory', 'Task history');
    applyAttr('#btn-menu', 'title', 'chatActions', 'Chat actions');
    applyAttr('#btn-settings', 'title', 'settings', 'Settings');
    applyAttr('#btn-new-chat-view', 'title', 'newChat', 'New chat');
    applyAttr('#scroll-to-bottom', 'title', 'jumpToLatestMessage', 'Jump to latest message');
    applyAttr('#scroll-to-bottom', 'aria-label', 'jumpToLatestMessage', 'Jump to latest message');
    applyAttr('#composer-input', 'placeholder', 'askAgent', 'Ask agent...');
    applyAttr('#btn-attach-file', 'title', 'attachFiles', 'Attach files');
    applyText('.attach-files-label', 'attachFiles', 'Attach files');
    applyAttr('#env-switcher', 'title', 'switchBridgeAgent', 'Switch bridge / agent');
    applyAttr('#model-display', 'title', 'changeModel', 'Change model');
    applyAttr('#sandbox-display', 'title', 'sandboxApprovals', 'Sandbox / approvals');
    applyAttr('#sandbox-display', 'aria-label', 'sandboxApprovals', 'Sandbox / approvals');
    applyAttr('#btn-send', 'title', 'send', 'Send');
    applyMarked(document);
  }

  window.junctionT = t;
  window.junctionLocale = locale;
  window.junctionApplyL10n = applyMarked;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStaticChrome, { once: true });
  } else {
    applyStaticChrome();
  }
})();
