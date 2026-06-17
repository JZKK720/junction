/* ==========================================================================
   activity-timeline.js - Timeline-only activity behavior.

   Only the LAST user message above the viewport is pinned while scrolling.
   CSS handles sticky behavior for `.chat-row.user.timeline-sticky-user`.
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  var scheduled = false;
  var scrollScheduled = false;
  var BOTTOM_THRESHOLD = 120;

  function isTimelineMode() {
    return document.body.classList.contains('stream-layout-timeline');
  }

  function userRows() {
    if (!messagesDiv) return [];
    return Array.prototype.slice.call(messagesDiv.querySelectorAll(':scope > .chat-row.user'));
  }

  function hasUserText(row) {
    var text = row && row.querySelector(':scope > .msg-text');
    return !!(text && String(text.dataset.rawText || text.textContent || '').trim());
  }

  function isNearBottom() {
    if (!messagesDiv) return false;
    return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < BOTTOM_THRESHOLD;
  }

  function clearTimelineStickyUserRows() {
    userRows().forEach(function (row) {
      row.classList.remove('timeline-sticky-user', 'timeline-user-pinnable', 'sticky-user-row', 'accordion-sticky-user');
    });
  }
  window.clearTimelineStickyUserRows = clearTimelineStickyUserRows;

  function syncTimelineStickyUserRows() {
    if (!messagesDiv || !isTimelineMode()) {
      clearTimelineStickyUserRows();
      return;
    }

    var rows = userRows();
    var nearBottom = isNearBottom();

    // Find the last user message whose top is at or above the scroll viewport top
    var stickyIdx = -1;
    if (!nearBottom) {
      var scrollTop = messagesDiv.scrollTop;
      for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i].offsetTop <= scrollTop + 2) {
          stickyIdx = i;
          break;
        }
      }
      // If no user message has scrolled past top, pin the first one
      if (stickyIdx === -1 && rows.length > 0 && hasUserText(rows[0])) {
        stickyIdx = 0;
      }
    }

    rows.forEach(function (row, idx) {
      row.classList.remove('timeline-user-pinnable', 'sticky-user-row', 'accordion-sticky-user');
      if (idx === stickyIdx && hasUserText(row)) {
        row.classList.add('timeline-sticky-user');
      } else {
        row.classList.remove('timeline-sticky-user');
      }
    });
  }
  window.syncTimelineStickyUserRows = syncTimelineStickyUserRows;

  function scheduleSyncTimelineStickyUserRows() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      syncTimelineStickyUserRows();
    });
  }
  window.scheduleSyncTimelineStickyUserRows = scheduleSyncTimelineStickyUserRows;

  function onScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(function () {
      scrollScheduled = false;
      syncTimelineStickyUserRows();
    });
  }

  if (messagesDiv && typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleSyncTimelineStickyUserRows)
      .observe(messagesDiv, { childList: true, subtree: true, characterData: true });
  }

  var scrollEl = messagesDiv;
  if (scrollEl) scrollEl.addEventListener('scroll', onScroll, { passive: true });

  scheduleSyncTimelineStickyUserRows();
})();
