/* ==========================================================================
   activity-timeline.js - Timeline-only activity behavior.
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  var observer = null;

  function isTimelineMode() {
    return document.body.classList.contains('stream-layout-timeline');
  }

  function clearTimelineStickyUserRows() {
    document.querySelectorAll('#chat-messages .chat-row.user').forEach(function (row) {
      row.classList.remove('timeline-sticky-user', 'sticky-user-row', 'accordion-sticky-user');
    });
  }
  window.clearTimelineStickyUserRows = clearTimelineStickyUserRows;

  function syncTimelineStickyUserRows() {
    if (!isTimelineMode()) {
      clearTimelineStickyUserRows();
      return;
    }
    document.querySelectorAll('#chat-messages .chat-row.user').forEach(function (row) {
      var text = row.querySelector('.msg-text');
      var hasText = !!(text && String(text.dataset.rawText || text.textContent || '').trim());
      row.classList.remove('sticky-user-row', 'accordion-sticky-user');
      row.classList.toggle('timeline-sticky-user', hasText);
    });
  }
  window.syncTimelineStickyUserRows = syncTimelineStickyUserRows;

  if (messagesDiv && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(function (records) {
      if (!records.some(function (record) { return record.addedNodes && record.addedNodes.length; })) return;
      syncTimelineStickyUserRows();
    });
    observer.observe(messagesDiv, { childList: true });
  }
})();
