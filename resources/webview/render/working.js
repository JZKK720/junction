/* ==========================================================================
   working.js — Single chat curtain animation
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  var curtain = document.getElementById('pinned-anim-throbber');
  var activeCanvas = null;
  var fadeTimer = null;
  var isActive = false;

  function ensureCurtain() {
    if (!messagesDiv) return null;
    if (!curtain) {
      curtain = document.createElement('div');
      curtain.id = 'pinned-anim-throbber';
      curtain.className = 'pinned-throbber';
      curtain.setAttribute('aria-hidden', 'true');
      messagesDiv.appendChild(curtain);
    } else if (curtain.parentNode !== messagesDiv) {
      messagesDiv.appendChild(curtain);
    }
    return curtain;
  }

  function stopCanvas() {
    if (activeCanvas && typeof activeCanvas._stopAnimation === 'function') {
      try { activeCanvas._stopAnimation(); } catch (e) {}
    }
    if (activeCanvas) {
      activeCanvas.width = 0;
      activeCanvas.height = 0;
      activeCanvas.remove();
    }
    activeCanvas = null;
  }

  function curtainText(width) {
    var fontSize = parseInt(getComputedStyle(document.body).fontSize, 10) || 13;
    var charWidth = Math.max(6, fontSize * 0.58);
    var count = Math.max(24, Math.floor(width / charWidth));
    return new Array(count + 1).join('\u2500');
  }

  function startChatCurtain() {
    var host = ensureCurtain();
    if (!host || !window.createAnimatedCanvas) return;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    var width = Math.max(240, messagesDiv.clientWidth - 24);
    if (isActive && activeCanvas && Math.abs((activeCanvas._curtainWidth || 0) - width) < 8) {
      host.style.display = 'block';
      host.style.opacity = '1';
      return;
    }
    stopCanvas();
    var duration = Math.round((window.getAnimVal('length', 2.0) || 2.0) * 1000);
    activeCanvas = window.createAnimatedCanvas(curtainText(width), {
      width: width,
      duration: duration,
      loop: true,
      mode: window._junctionAnimationMode || 'matrix'
    });
    if (!activeCanvas) return;
    activeCanvas._curtainWidth = width;
    activeCanvas.classList.add('chat-curtain-canvas');
    activeCanvas.style.width = '100%';
    activeCanvas.style.margin = '0 auto';
    host.innerHTML = '';
    host.appendChild(activeCanvas);
    host.style.display = 'block';
    host.style.opacity = '1';
    isActive = true;
  }

  function stopChatCurtain(immediate) {
    var host = ensureCurtain();
    isActive = false;
    if (!host) { stopCanvas(); return; }
    if (fadeTimer) clearTimeout(fadeTimer);
    var fade = immediate ? 0 : Number((window.animConfig && (window.animConfig.curtainFade ?? window.animConfig.splashFade)) ?? 0.3);
    var settleDelay = immediate ? 0 : 450;
    fadeTimer = setTimeout(function () {
      host.style.transition = fade > 0 ? ('opacity ' + fade + 's ease-out') : 'none';
      host.style.opacity = '0';
      fadeTimer = setTimeout(function () {
        stopCanvas();
        host.innerHTML = '';
        host.style.display = 'none';
        host.style.transition = '';
        fadeTimer = null;
      }, Math.max(0, fade * 1000));
    }, settleDelay);
  }

  function setWorking(active) {
    if (active) startChatCurtain();
    else stopChatCurtain(false);
  }

  function refreshWorking() {
    if (isActive) startChatCurtain();
  }

  function playChatCurtainPreview() {
    startChatCurtain();
    setTimeout(function () { stopChatCurtain(false); }, 2500);
  }

  window.setWorking = setWorking;
  window.refreshWorking = refreshWorking;
  window.startChatCurtain = startChatCurtain;
  window.stopChatCurtain = stopChatCurtain;
  window.playChatCurtainPreview = playChatCurtainPreview;
  window.suppressWorking = function () {};
  window.workingRow = null;
})();
