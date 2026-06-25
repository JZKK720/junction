/* ==========================================================================
   working.js — Single chat curtain animation
   ========================================================================== */
(function () {
  'use strict';

  var curtain = document.getElementById('pinned-anim-throbber');

  function stopCanvas() {
    if (curtain) {
      curtain.innerHTML = '';
      curtain.style.display = 'none';
    }
  }

  function startChatCurtain() {
    stopCanvas();
  }

  function stopChatCurtain(immediate) {
    stopCanvas();
  }

  function setWorking(active) {
    if (active) startChatCurtain();
    else stopChatCurtain(false);
  }

  function refreshWorking() {
    stopCanvas();
  }

  function playChatCurtainPreview() {
    stopCanvas();
  }

  window.setWorking = setWorking;
  window.refreshWorking = refreshWorking;
  window.startChatCurtain = startChatCurtain;
  window.stopChatCurtain = stopChatCurtain;
  window.playChatCurtainPreview = playChatCurtainPreview;
  window.suppressWorking = function () {};
  window.workingRow = null;
})();
