/* ==========================================================================
   activity-modules.js - Lazy loaders for layout-specific activity modules.
   ========================================================================== */
(function () {
  'use strict';

  var timelineState = 'idle';
  var timelineQueue = [];
  var scriptNonce = document.currentScript && (document.currentScript.nonce || document.currentScript.getAttribute('nonce'));

  function clearTimelineStickyUserRows() {
    document.querySelectorAll('#chat-messages .chat-row.user').forEach(function (row) {
      row.classList.remove('timeline-sticky-user', 'sticky-user-row', 'accordion-sticky-user');
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
})();
