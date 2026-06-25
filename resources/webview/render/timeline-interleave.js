/* ==========================================================================
   timeline-interleave.js — Per-bridge timeline interleaving (modular add-on).

   The shared unified/timeline renderer coalesces every reasoning burst into ONE
   note pinned to the TOP of the tool container (messages.js appendActivityThoughtText
   does block.insertBefore(note, block.firstChild)), while tool cards append to the
   bottom — so thoughts and tools never interleave in timeline mode.

   Bridges that emit one reasoning burst per tool-calling STEP (e.g. Hermes) want
   those bursts interleaved with their tools in chronological order. This module
   overrides window.appendActivityThoughtText ONLY when window.timelineInterleave is
   true (set from the active bridge's `timelineInterleaves` capability). For every
   other bridge the flag is false and the original function runs verbatim — byte-for
   byte identical behavior, no shared render file touched.

   Because both the live path (appendActivityNotes → appendActivityThoughtText) and
   the history path (renderActivityTimelineHistory → appendHistoryActivityNote →
   appendActivityThoughtText) funnel through this one function, and tool cards append
   to the same .tool-calls container in walk order, appending each note at the
   container's CURRENT end yields a correct [note][tool][note][tool…] intersperse.
   ========================================================================== */
(function () {
  'use strict';

  var original = window.appendActivityThoughtText;
  if (typeof original !== 'function') return;

  // Append a reasoning burst at the container's current end (chronological), reusing
  // the trailing note only when no tool has landed since — so each post-tool burst
  // opens its own note and the thoughts interleave with the tools.
  function appendInterleavedNote(container, raw) {
    var tail = container.lastElementChild;
    var note = (tail && tail.classList && tail.classList.contains('activity-thought-note')) ? tail : null;
    var contentNode = note && note.querySelector('.activity-thought-chunk');
    if (!note || !contentNode) {
      note = document.createElement('div');
      note.className = 'activity-note activity-thought-note';
      contentNode = document.createElement('div');
      contentNode.className = 'reasoning-content activity-thought-chunk';
      note.appendChild(contentNode);
      container.appendChild(note);
    }
    var prev = contentNode.getAttribute('data-raw-thinking') || contentNode.textContent || '';
    // Streaming bridges may flush reasoning in arbitrary chunks. Use shared
    // thought merge so chunks do not become a vertical list in timeline mode.
    var merged = window.mergeThoughtBlobText ? window.mergeThoughtBlobText(prev, raw) : (prev ? (prev.replace(/\s+$/, '') + ' ' + raw) : raw);
    contentNode.setAttribute('data-raw-thinking', merged);
    contentNode.innerHTML = window.formatThinkingContent
      ? window.formatThinkingContent(merged)
      : (window.renderMarkdown ? window.renderMarkdown(merged) : merged);
    if (window.updateActivityWorklogThoughtSummary) {
      window.updateActivityWorklogThoughtSummary(container.closest('.activity-worklog'));
    }
  }

  window.appendActivityThoughtText = function (block, text) {
    // Off for every non-opted-in bridge → exact original behavior.
    if (!window.timelineInterleave) return original(block, text);
    var raw = String(text || '').trim();
    if (!block || !raw) return;
    // Only the unified-timeline path (block === the shared .tool-calls container)
    // coalesces; that is the one we interleave. Everything else (accordion's own
    // .activity-thought disclosure) keeps the original behavior.
    if (block.classList && block.classList.contains('tool-calls')) {
      appendInterleavedNote(block, raw);
      return;
    }
    return original(block, text);
  };
})();
