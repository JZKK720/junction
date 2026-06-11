/* ==========================================================================
   chat-stream.js — Message stream renderer (the chat transcript)
   ==========================================================================
   Owns #chat-messages. Renders user/assistant rows, inline reasoning
   disclosures (stream expanded, auto-collapse on finish), tool-call cards,
   subagent labels, token footers, and per-message actions.

   Globals exposed for other modules:
     window.renderHistory(history)              — repaint transcript (view-router)
     window.getOrCreateAssistantMessage(runId)  — assistant row (compat)

   Inbound messages handled:
     history · userEcho · response · assistant_stream_start/delta/end ·
     thinking_chunk · thinking_end · tool_start · tool_update · tool_result ·
     subagentInfo · tokenUsage
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;

  // ── Markdown ──────────────────────────────────────────────────────────────
  var md = { render: function (t) { return escapeHtml(t).replace(/\n/g, '<br>'); } };
  if (window.markdownit) {
    md = window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
      highlight: function (str, lang) {
        return '<pre><code class="language-' + escapeHtml(lang || '') + '">' + simpleHighlight(str, lang) + '</code></pre>';
      }
    });
  }
  // ── Simple syntax highlighter ─────────────────────────────────────────────
  function simpleHighlight(code, lang) {
    // Tokenize: split into alternating [text, type] pairs
    // Then join with spans, preserving newlines exactly.
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
    // Simple single-pass tokenization
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

  // ── Pretext canvas animation renderer ────────────────────────────────────
  var extraRichEnabled = true; // default on
  var matrixChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,.<>?/~`';
  var PretextAPI = window.Pretext || null;

  /** Get font string from computed style. */
  function getCurrentFont() {
    var s = getComputedStyle(document.body);
    return (s.fontWeight || '400') + ' ' + (s.fontSize || '13px') + ' ' + (s.fontFamily || 'monospace');
  }

  // ── Animation control defaults ────────────────────────────────────────────
  var animConfig = {
    speed: 1.0,    // 0.25–4.0
    fontSize: 1.0, // 0.5–2.0 multiplier
    density: 1.0,  // 0.25–2.0
    intensity: 1.0,// 0.25–2.0
    loop: false,
    length: 2.0,   // duration in seconds
    bgColor: 'theme',
    bgAlpha: 0.05
  };
  window.animConfig = animConfig; // expose for composer.js cross-script access
  var ANIM_MODES = ['matrix','zalgo','fire','bounce','spiral'];
  window.ANIM_MODES = ANIM_MODES; // expose for composer.js cross-script access
  if (!window._junctionAnimColor) {
    window._junctionAnimColor = getComputedStyle(document.body).color || '#ccc';
  }

  function getAnimSpeed() { return animConfig.speed; }
  function getAnimFontSize() { return animConfig.fontSize; }
  function getAnimDensity() { return animConfig.density; }
  function getAnimIntensity() { return animConfig.intensity; }

  function getAnimationBgColor(alpha) {
    var bg = getComputedStyle(document.body).backgroundColor || 'rgba(30,30,30,1)';
    if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') bg = 'rgb(30, 30, 30)';
    var configBg = animConfig.bgColor || 'theme';
    if (configBg !== 'theme') {
      bg = configBg;
    }
    var a = (alpha !== undefined) ? alpha : (animConfig.bgAlpha || 0.05);

    // Parse rgb(r, g, b) or rgba(r, g, b, a)
    var m = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/);
    if (m) {
      return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a + ')';
    }
    // Parse #hex
    if (bg.startsWith('#')) {
      var hex = bg.substring(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      var r = parseInt(hex.substring(0,2), 16);
      var g = parseInt(hex.substring(2,4), 16);
      var b = parseInt(hex.substring(4,6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return 'rgba(0,0,0,' + a + ')';
  }

  // ── Fire mode ─────────────────────────────────────────────────────────────
  function createFireCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize());
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var tw = Math.ceil(maxWidth) + 20;
    var th = lines.length * lineHeight + 20;

    // Fire simulation grid (low-res)
    var fireW = Math.min(128, Math.ceil(tw / 4));
    var fireH = Math.min(80, Math.ceil(th / 4));
    var heat = new Float32Array(fireW * fireH); // heat buffer
    var color = new Float32Array(fireW * fireH); // color buffer
    var speed = getAnimSpeed();
    var density = getAnimDensity();
    var intensity = getAnimIntensity();

    function getFirePixel(h, c) {
      var r, g, b;
      var isGreen = (window._junctionAnimColor === '#10a37f');
      if (isGreen) {
        if (h < 0.25) {
          r = 0; g = Math.floor(h * 4 * 180); b = 0;
        } else if (h < 0.5) {
          r = 0; g = 180 + Math.floor((h - 0.25) * 4 * 75); b = Math.floor((h - 0.25) * 4 * 60);
        } else if (h < 0.75) {
          r = Math.floor((h - 0.5) * 4 * 140); g = 255; b = 60 + Math.floor((h - 0.5) * 4 * 30);
        } else {
          r = 200 + Math.floor((h - 0.75) * 4 * 55); g = 255; b = 200 + Math.floor((h - 0.75) * 4 * 55);
        }
      } else {
        if (h < 0.25) {
          r = Math.floor(h * 4 * 180); g = 0; b = 0;
        } else if (h < 0.5) {
          r = 180 + Math.floor((h - 0.25) * 4 * 75); g = Math.floor((h - 0.25) * 4 * 60); b = 0;
        } else if (h < 0.75) {
          r = 255; g = 60 + Math.floor((h - 0.5) * 4 * 140); b = Math.floor((h - 0.5) * 4 * 30);
        } else {
          r = 255; g = 200 + Math.floor((h - 0.75) * 4 * 55); b = 30 + Math.floor((h - 0.75) * 4 * 100);
        }
      }
      var flicker = 0.85 + c * 0.3;
      return {
        r: Math.min(255, Math.floor(r * flicker)),
        g: Math.min(255, Math.floor(g * flicker)),
        b: Math.min(255, Math.floor(b * flicker))
      };
    }

    // Seed bottom row with text heat
    function seedText() {
      ctx.font = fontStr;
      lines.forEach(function (line, i) {
        var y = Math.floor(((i + 1) * lineHeight) / 4);
        if (y >= fireH) return;
        for (var x = 0; x < fireW; x++) {
          // Approximate text coverage
          var px = x * 4;
          var charAtX = Math.floor(px / fontSize);
          if (charAtX < line.length && line.charAt(charAtX) !== ' ') {
            heat[(y * fireW) + x] = 0.8 + Math.random() * 0.2;
            color[(y * fireW) + x] = Math.random();
          }
        }
      });
    }

    // Two-noise flicker: heat dissipates upward, color shifts with second noise
    function propagateFire() {
      for (var y = 1; y < fireH; y++) {
        for (var x = 0; x < fireW; x++) {
          var idx = y * fireW + x;
          var below = ((y - 1) * fireW) + x;
          var spread = 0;
          if (x > 0) spread += heat[below - 1] * 0.3;
          spread += heat[below] * 0.5;
          if (x < fireW - 1) spread += heat[below + 1] * 0.3;
          // Second noise layer: random flicker
          var noise2 = (Math.random() - 0.5) * 0.15 * intensity;
          heat[idx] = Math.max(0, Math.min(1, spread * 0.65 + noise2));
          // Color drift: second noise filter
          color[idx] = (color[idx] * 0.9 + Math.random() * 0.1 * intensity);
        }
      }
      // Re-seed bottom with noise
      for (var x = 0; x < fireW; x++) {
        if (Math.random() < density * 0.3) {
          heat[(fireH - 1) * fireW + x] = 0.6 + Math.random() * 0.4;
        }
      }
    }

    canvas.width = tw;
    canvas.height = th;
    canvas.style.width = tw + 'px';
    canvas.style.height = th + 'px';

    var startTime = performance.now();
    var duration = opts.duration || (window.animConfig.length * 1000) || 2000;
    var done = false;
    var animId = null;

    seedText();

    function frame() {
      if (done) return;

      if (opts.loader) {
        propagateFire();
        var imgData = ctx.createImageData(tw, th);
        var pixels = imgData.data;
        for (var fy = 0; fy < fireH; fy++) {
          for (var fx = 0; fx < fireW; fx++) {
            var h = heat[fy * fireW + fx];
            var c = color[fy * fireW + fx];
            if (h < 0.02) continue;
            var rgb = getFirePixel(h, c);
            for (var dy = 0; dy < 4 && (fy * 4 + dy) < th; dy++) {
              for (var dx = 0; dx < 4 && (fx * 4 + dx) < tw; dx++) {
                var pi = ((fy * 4 + dy) * tw + (fx * 4 + dx)) * 4;
                pixels[pi] = rgb.r; pixels[pi + 1] = rgb.g; pixels[pi + 2] = rgb.b; pixels[pi + 3] = 255;
              }
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);

        ctx.font = fontStr;
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
        lines.forEach(function (line, i) {
          ctx.fillText(line, 10, (i + 1) * lineHeight);
        });
        ctx.globalAlpha = 1;

        animId = requestAnimationFrame(frame);
        return;
      }

      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);

      propagateFire();

      // Draw fire grid
      var imgData = ctx.createImageData(tw, th);
      var pixels = imgData.data;
      for (var fy = 0; fy < fireH; fy++) {
        for (var fx = 0; fx < fireW; fx++) {
          var h = heat[fy * fireW + fx];
          var c = color[fy * fireW + fx];
          if (h < 0.02) continue;
          var rgb = getFirePixel(h, c);
          // Paint 4x4 block
          for (var dy = 0; dy < 4 && (fy * 4 + dy) < th; dy++) {
            for (var dx = 0; dx < 4 && (fx * 4 + dx) < tw; dx++) {
              var pi = ((fy * 4 + dy) * tw + (fx * 4 + dx)) * 4;
              pixels[pi] = rgb.r; pixels[pi + 1] = rgb.g; pixels[pi + 2] = rgb.b; pixels[pi + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);

      // Draw text on top (fading in)
      if (progress > 0.3) {
        var textAlpha = Math.min(1, (progress - 0.3) / 0.5);
        ctx.font = fontStr;
        ctx.globalAlpha = textAlpha;
        ctx.fillStyle = '#fff';
        lines.forEach(function (line, i) {
          ctx.fillText(line, 10, (i + 1) * lineHeight);
        });
        ctx.globalAlpha = 1;
      }

      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || (window.animConfig && window.animConfig.loop)) {
          startTime = performance.now();
          heat.fill(0);
          color.fill(0);
          seedText();
          animId = requestAnimationFrame(frame);
        } else {
          done = true;
          ctx.clearRect(0, 0, tw, th);
          ctx.font = fontStr;
          ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
          lines.forEach(function (line, i) {
            ctx.fillText(line, 10, (i + 1) * lineHeight);
          });
        }
      }
    }

    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // ── Bounce mode ───────────────────────────────────────────────────────────
  function createBounceCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize());
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var tw = Math.ceil(maxWidth) + 20;
    var th = lines.length * lineHeight + 20;
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    // Split text into individual characters with random start positions
    var chars = [];
    var fullText = lines.join('');
    for (var i = 0; i < fullText.length; i++) {
      var ch = fullText.charAt(i);
      if (ch === ' ') continue;
      // Find target position
      var row = 0, col = 0, count = 0;
      for (var r = 0; r < lines.length; r++) {
        for (var c = 0; c < lines[r].length; c++) {
          if (count === i) { row = r; col = c; break; }
          count++;
        }
        if (count === i) break;
      }
      var targetX = col * fontSize * 0.6 + 10;
      var targetY = (row + 1) * lineHeight;
      // Random start: bounce in from edge
      var angle = Math.random() * Math.PI * 2;
      var dist = 200 + Math.random() * 300;
      chars.push({
        ch: ch,
        targetX: targetX,
        targetY: targetY,
        x: targetX + Math.cos(angle) * dist,
        y: targetY + Math.sin(angle) * dist,
        rotation: (Math.random() - 0.5) * 12,
        targetRotation: 0,
        bouncePhase: opts.loader ? (i * 0.4) : (Math.random() * Math.PI * 2),
        delay: i * (30 / getAnimSpeed()),
        settled: false
      });
    }

    var startTime = performance.now();
    var duration = opts.duration || (window.animConfig.length * 1000) || 2500;
    var done = false;
    var animId = null;

    function frame() {
      if (done) return;

      if (opts.loader) {
        ctx.clearRect(0, 0, tw, th);
        ctx.font = fontStr;
        var fgColor = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
        chars.forEach(function (c) {
          var yOffset = Math.sin(performance.now() * 0.005 * getAnimSpeed() + c.bouncePhase) * (lineHeight * 0.3 * getAnimIntensity());
          ctx.save();
          ctx.translate(c.targetX, c.targetY + yOffset);
          ctx.globalAlpha = 1;
          ctx.fillStyle = fgColor;
          ctx.fillText(c.ch, 0, 0);
          ctx.restore();
        });
        animId = requestAnimationFrame(frame);
        return;
      }

      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);

      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;

      var fgColor = getComputedStyle(document.body).color || '#ccc';

      chars.forEach(function (c) {
        var t = Math.max(0, Math.min(1, (elapsed - c.delay) / 800));
        if (t <= 0) return;

        // Elastic ease-out
        var ease = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 2 + c.bouncePhase) * (t < 0.9 ? 1 : 0);
        ease = Math.max(0, Math.min(1, ease));

        var curX = c.x + (c.targetX - c.x) * ease;
        var curY = c.y + (c.targetY - c.y) * ease;
        var curRot = c.rotation * (1 - ease);

        ctx.save();
        ctx.translate(curX, curY);
        ctx.rotate(curRot);
        ctx.globalAlpha = ease;
        ctx.fillStyle = fgColor;
        ctx.fillText(c.ch, 0, 0);
        ctx.restore();
      });

      ctx.globalAlpha = 1;

      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || (window.animConfig && window.animConfig.loop)) {
          startTime = performance.now();
          animId = requestAnimationFrame(frame);
        } else {
          done = true;
          ctx.clearRect(0, 0, tw, th);
          ctx.font = fontStr;
          ctx.fillStyle = fgColor;
          lines.forEach(function (line, i) {
            ctx.fillText(line, 10, (i + 1) * lineHeight);
          });
        }
      }
    }

    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // ── Spiral mode ───────────────────────────────────────────────────────────
  function createSpiralCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize());
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var tw = Math.ceil(maxWidth) + 20;
    var th = lines.length * lineHeight + 20;
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var centerX = tw / 2;
    var centerY = th / 2;
    var fgColor = getComputedStyle(document.body).color || '#ccc';

    // Split into characters with spiral trajectories
    var chars = [];
    var fullText = lines.join('');
    for (var i = 0; i < fullText.length; i++) {
      var ch = fullText.charAt(i);
      if (ch === ' ') continue;
      var row = 0, col = 0, count = 0;
      for (var r = 0; r < lines.length; r++) {
        for (var c = 0; c < lines[r].length; c++) {
          if (count === i) { row = r; col = c; break; }
          count++;
        }
        if (count === i) break;
      }
      var targetX = col * fontSize * 0.6 + 10;
      var targetY = (row + 1) * lineHeight;
      // Spiral start: angle based on index, distance from center
      var spiralAngle = i * 2.4 + Math.random() * 0.5; // golden-ish angle
      var spiralDist = 150 + Math.random() * 200;
      chars.push({
        ch: ch,
        targetX: targetX,
        targetY: targetY,
        startAngle: spiralAngle,
        startDist: spiralDist,
        delay: i * (20 / getAnimSpeed()),
        hue: (i * 37) % 360
      });
    }

    var startTime = performance.now();
    var duration = opts.duration || (window.animConfig.length * 1000) || 2200;
    var done = false;
    var animId = null;

    function frame() {
      if (done) return;

      if (opts.loader) {
        ctx.clearRect(0, 0, tw, th);
        ctx.font = fontStr;
        chars.forEach(function (c) {
          var orbitRadius = 8 * getAnimIntensity();
          var curX = c.targetX + Math.cos(orbitAngle) * orbitRadius;
          var curY = c.targetY + Math.sin(orbitAngle) * orbitRadius;
          ctx.save();
          ctx.translate(curX, curY);
          ctx.globalAlpha = 1;
          var fillStyle = 'hsl(' + c.hue + ', 70%, 70%)';
          if (window._junctionAnimColor === '#10a37f') {
            fillStyle = 'hsl(' + ((c.hue % 40) + 130) + ', 80%, 55%)';
          }
          ctx.fillStyle = fillStyle;
          ctx.fillText(c.ch, 0, 0);
          ctx.restore();
        });
        animId = requestAnimationFrame(frame);
        return;
      }

      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);

      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;

      chars.forEach(function (c) {
        var t = Math.max(0, Math.min(1, (elapsed - c.delay) / 1000));
        if (t <= 0) return;

        // Spiral inward: angle increases, distance decreases
        var spiralProgress = t * t * t; // cubic ease
        var curAngle = c.startAngle + spiralProgress * 8; // rotate while spiraling in
        var curDist = c.startDist * (1 - spiralProgress);
        var curX = centerX + Math.cos(curAngle) * curDist;
        var curY = centerY + Math.sin(curAngle) * curDist;
        var curAlpha = Math.min(1, t * 2);
        var curScale = 0.5 + spiralProgress * 0.5;

        ctx.save();
        ctx.translate(curX, curY);
        ctx.scale(curScale, curScale);
        ctx.globalAlpha = curAlpha;
        ctx.fillStyle = 'hsl(' + c.hue + ', 70%, 70%)';
        ctx.fillText(c.ch, 0, 0);
        ctx.restore();
      });

      ctx.globalAlpha = 1;

      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || (window.animConfig && window.animConfig.loop)) {
          startTime = performance.now();
          animId = requestAnimationFrame(frame);
        } else {
          done = true;
          ctx.clearRect(0, 0, tw, th);
          ctx.font = fontStr;
          ctx.fillStyle = fgColor;
          lines.forEach(function (line, i) {
            ctx.fillText(line, 10, (i + 1) * lineHeight);
          });
        }
      }
    }

    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // ── Matrix-scroll canvas (default) ────────────────────────────────────────
  function createMatrixCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize());
    var lineHeight = Math.round(fontSize * 1.5);

    var prepared = null;
    var lines = [];
    if (PretextAPI && PretextAPI.prepareWithSegments && PretextAPI.layoutWithLines) {
      try {
        prepared = PretextAPI.prepareWithSegments(text, fontStr);
        var containerWidth = (opts.width || 600);
        var layoutResult = PretextAPI.layoutWithLines(prepared, containerWidth, lineHeight);
        lines = (layoutResult.lines || []).map(function (l) { return l.text || l; });
      } catch (e) { lines = text.split('\n'); }
    } else {
      lines = text.split('\n');
    }
    if (lines.length === 0) lines = [''];

    ctx.font = fontStr;
    var maxWidth = 0;
    lines.forEach(function (line) { maxWidth = Math.max(maxWidth, ctx.measureText(line).width); });
    var tw = Math.ceil(maxWidth) + 20;
    var th = lines.length * lineHeight + 20;
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var charWidth = fontSize * 0.6;
    var cols = Math.ceil(tw / charWidth);
    var colStates = [];
    for (var c = 0; c < cols; c++) {
      colStates.push({
        phase: 'rain',
        y: th + Math.random() * 60,
        speed: (1.2 + Math.random() * 2.5) * getAnimSpeed(),
        char: matrixChars[Math.floor(Math.random() * matrixChars.length)],
        opacity: 0.2 + Math.random() * 0.6
      });
    }

    var startTime = performance.now();
    var duration = opts.duration || (window.animConfig.length * 1000) || 1200;
    var done = false;
    var animId = null;
    var fgColor = getComputedStyle(document.body).color || '#ccc';

    function frame(now) {
      if (done) return;
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;
      lines.forEach(function (line, i) {
        var settleProgress = Math.max(0, Math.min(1, (progress - 0.2 - i * 0.04) / 0.35));
        if (settleProgress > 0) {
          ctx.globalAlpha = settleProgress;
          ctx.fillStyle = fgColor;
          ctx.fillText(line, 10, (i + 1) * lineHeight);
        }
      });
      ctx.globalAlpha = 1;
      colStates.forEach(function (col, ci) {
        if (col.phase === 'done') return;
        if (col.phase === 'rain') {
          col.y -= col.speed * 2;
          if (col.y < -20) { col.phase = 'done'; return; }
          ctx.globalAlpha = col.opacity * Math.max(0, 1 - progress);
          ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
          ctx.fillText(col.char, ci * charWidth, col.y);
        }
      });
      ctx.globalAlpha = 1;
      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || (window.animConfig && window.animConfig.loop)) {
          startTime = performance.now();
          colStates.forEach(function (col) {
            col.phase = 'rain';
            col.y = th + Math.random() * 60;
          });
          animId = requestAnimationFrame(frame);
        } else {
          done = true;
          ctx.clearRect(0, 0, tw, th);
          ctx.font = fontStr;
          ctx.fillStyle = fgColor;
          lines.forEach(function (line, i) {
            ctx.fillText(line, 10, (i + 1) * lineHeight);
          });
        }
      }
    }
    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // Zalgo combining characters for glitch effect
  var ZALGO_UP = ['\u0300','\u0301','\u0302','\u0303','\u0304','\u0305','\u0306','\u0307','\u0308','\u0309','\u030A','\u030B','\u030C','\u030D','\u030E','\u030F','\u0310','\u0311','\u0312','\u0313','\u0314','\u0315','\u031A','\u031B','\u033D','\u033E','\u033F','\u0340','\u0341','\u0342','\u0343','\u0344','\u0346','\u034A','\u034B','\u034C','\u034F','\u0350','\u0351','\u0352','\u0357','\u0358','\u035C','\u035D','\u035E','\u0360','\u0361'];
  var ZALGO_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!';

  /** Create a zalgo-rising animation above a baseline. */
  function createZalgoCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = parseInt(getComputedStyle(document.body).fontSize) || 13;
    var lineHeight = Math.round(fontSize * 1.5);

    // Use Pretext to measure the baseline line
    var baselineText = text || '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
    var baselineWidth = 300;
    if (PretextAPI && PretextAPI.prepareWithSegments && PretextAPI.measureNaturalWidth) {
      try {
        var prepared = PretextAPI.prepareWithSegments(baselineText, fontStr);
        baselineWidth = PretextAPI.measureNaturalWidth(prepared);
      } catch (e) {}
    } else {
      ctx.font = fontStr;
      baselineWidth = ctx.measureText(baselineText).width;
    }

    // Calculate columns from baseline width
    var charWidth = fontSize * 0.55;
    var numCols = Math.max(4, Math.floor((baselineWidth / charWidth) * getAnimDensity()));
    var riseHeight = fontSize * 4 * getAnimIntensity(); // how high zalgo rises above baseline
    var canvasWidth = baselineWidth + 20;
    var canvasHeight = riseHeight + lineHeight + 10;

    canvas.width = Math.ceil(canvasWidth);
    canvas.height = Math.ceil(canvasHeight);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';

    var baselineY = canvasHeight - lineHeight;

    // Each column has a base character and accent information
    var columns = [];
    function initColumns() {
      columns = [];
      for (var c = 0; c < numCols; c++) {
        var startY = baselineY;
        if (opts.loader) {
          // pre-scatter columns vertically so they don't rise in unison
          startY = 10 + Math.random() * (baselineY - 10);
        }
        columns.push({
          x: c * charWidth + 10,
          baseChar: ZALGO_CHARS[Math.floor(Math.random() * ZALGO_CHARS.length)],
          accentSeed: Math.floor(Math.random() * 100),
          opacity: 0.3 + Math.random() * 0.7,
          speed: 0.8 + Math.random() * 1.5,
          settled: false,
          y: startY
        });
      }
    }
    initColumns();

    var startTime = performance.now();
    var duration = opts.duration || (window.animConfig.length * 1000) || 1500;
    var done = false;
    var animId = null;

    function frame(now) {
      if (done) return;

      if (opts.loader) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = fontStr;

        // Draw baseline line (static)
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
        ctx.fillText(baselineText, 10, baselineY);

        columns.forEach(function (col) {
          // Continuous rise
          col.y -= col.speed * 0.5 * getAnimSpeed();
          if (col.y < 10) {
            col.y = baselineY;
            col.baseChar = ZALGO_CHARS[Math.floor(Math.random() * ZALGO_CHARS.length)],
            col.accentSeed = Math.floor(Math.random() * 100);
          }

          var timeFactor = performance.now() * 0.008 * getAnimSpeed() * col.speed;
          var rawCount = 3 + Math.sin(timeFactor + col.x * 0.05) * 4;
          var numAccents = Math.max(1, Math.min(8, Math.round(rawCount)));

          var marks = '';
          for (var i = 0; i < numAccents; i++) {
            marks += ZALGO_UP[(col.accentSeed + i) % ZALGO_UP.length];
          }

          var glitchX = Math.sin(performance.now() * 0.01 + col.x) * 2;
          ctx.globalAlpha = col.opacity;
          ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
          ctx.fillText(col.baseChar + marks, col.x + glitchX, col.y);
        });

        ctx.globalAlpha = 1;
        animId = requestAnimationFrame(frame);
        return;
      }

      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = fontStr;

      // Draw baseline line (static)
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
      ctx.fillText(baselineText, 10, baselineY);

      // Draw rising zalgo columns
      columns.forEach(function (col) {
        if (col.settled) return;

        // Rise progress per column (staggered)
        var colProgress = Math.max(0, Math.min(1, (progress - Math.random() * 0.2) / 0.6));
        var rise = colProgress * riseHeight;
        var y = baselineY - rise;

        // Dynamic accents: make the stack taller and shorter over time
        var timeFactor = elapsed * 0.008 * getAnimSpeed() * col.speed;
        var rawCount = 3 + Math.sin(timeFactor + col.x * 0.05) * 4; // oscillates between -1 and 7
        var numAccents = Math.max(1, Math.min(8, Math.round(rawCount)));

        var marks = '';
        for (var i = 0; i < numAccents; i++) {
          marks += ZALGO_UP[(col.accentSeed + i) % ZALGO_UP.length];
        }

        // Glitch: combining chars shift the glyph
        var glitchX = Math.sin(elapsed * 0.01 + col.x) * 2;
        ctx.globalAlpha = col.opacity * (1 - progress * 0.3);
        ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
        ctx.fillText(col.baseChar + marks, col.x + glitchX, y);

        if (progress >= 0.95) col.settled = true;
      });

      ctx.globalAlpha = 1;

      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || (window.animConfig && window.animConfig.loop)) {
          startTime = performance.now();
          initColumns();
          animId = requestAnimationFrame(frame);
        } else {
          done = true;
          // Final: just the line + faint settled text
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.font = fontStr;
          ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
          ctx.globalAlpha = 0.5;
          ctx.fillText(baselineText, 10, baselineY);
          ctx.globalAlpha = 1;
        }
      }
    }

    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // ── Dispatcher ────────────────────────────────────────────────────────────
  function createAnimatedCanvas(text, opts) {
    opts = opts || {};
    var mode = window._junctionAnimationMode || 'matrix';
    if (opts.loader && mode === 'matrix') {
      return createMatrixLoader(opts.width, opts.height || 40);
    }
    switch (mode) {
      case 'zalgo': return createZalgoCanvas(text, opts);
      case 'fire': return createFireCanvas(text, opts);
      case 'bounce': return createBounceCanvas(text, opts);
      case 'spiral': return createSpiralCanvas(text, opts);
      default: return createMatrixCanvas(text, opts);
    }
  }
  window.createAnimatedCanvas = createAnimatedCanvas; // expose for composer.js

  /** Matrix-style loading animation for boot/working states. */
  function createMatrixLoader(width, height) {
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas matrix-loader';
    canvas.width = width || 200;
    canvas.height = height || 40;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontSize = Math.round(11 * getAnimFontSize());
    ctx.font = fontSize + 'px monospace';
    var cols = Math.max(2, Math.floor((canvas.width / fontSize) * getAnimDensity()));
    var drops = [];
    for (var i = 0; i < cols; i++) {
      drops.push({ y: Math.random() * canvas.height, speed: (0.5 + Math.random() * 1.5) * getAnimIntensity() });
    }

    var animId = null;
    function draw() {
      if (canvas.closest && canvas.closest('#startup-loader.dismissed')) return;
      ctx.fillStyle = getAnimationBgColor(animConfig.bgAlpha || 0.05);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = window._junctionAnimColor || getComputedStyle(document.body).color || '#ccc';
      ctx.font = fontSize + 'px monospace';
      drops.forEach(function (drop, i) {
        var ch = matrixChars[Math.floor(Math.random() * matrixChars.length)];
        ctx.globalAlpha = 0.5 + Math.random() * 0.5;
        ctx.fillText(ch, i * fontSize, drop.y);
        drop.y += drop.speed * fontSize * 0.5 * getAnimSpeed();
        if (drop.y > canvas.height && Math.random() > 0.975) {
          drop.y = 0;
        }
      });
      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(draw);
    }
    draw();
    canvas._stopAnimation = function () { if (animId) cancelAnimationFrame(animId); };
    return canvas;
  }

  // ── Simple syntax highlighter ─────────────────────────────────────────────
  function renderMarkdown(text) {
    try {
      var t = String(text || '').trim();
      // Raw JSON payloads render as a highlighted block, not markdown mush.
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

  /** Post-process HTML to turn file paths into clickable links. */
  function linkifyFilePaths(html) {
    // Match paths like: src/ui/chatBase.ts, package.json, ./foo/bar.js, ~/sauce/foo.ts
    // Must have a file extension and look like a path (contain / or start with ./ or ~/)
    var pathRe = /(?<!["'=\w])(\.\.?\/[\w.\-\/]+|[~\/]\w[\w.\-\/]*\.\w{1,10}|(?:[\w]+\.)+[\w]{1,10})(?!["'<>\w])/g;
    var seen = new Set();
    return html.replace(pathRe, function (match) {
      // Skip if it's inside an HTML tag or already a link
      if (seen.has(match)) return match;
      seen.add(match);
      // Don't linkify things that are clearly not files (single words without dots, etc.)
      if (!match.includes('/') && !match.startsWith('.') && !match.startsWith('~')) return match;
      if (!match.match(/\.[a-z]{1,10}$/i)) return match;
      return '<span class="file-link" data-file="' + escapeHtml(match) + '" title="Open ' + escapeHtml(match) + '">' + escapeHtml(match) + '</span>';
    });
  }
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  // Only auto-scroll if user is already near the bottom (sticky scroll).
  function isNearBottom() {
    if (!messagesDiv) return true;
    var threshold = 80; // px from bottom
    return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < threshold;
  }
  function scrollToBottom() {
    if (isNearBottom()) {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }
  function forceScrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  // ── Share / export chat ──────────────────────────────────────────────────
  // ── Per-message share popover ──────────────────────────────────────────
  function openShareForRow(row) {
    if (!row) return;
    var existing = document.getElementById('share-row-menu');
    if (existing) { existing.remove(); return; }
    var text = (row.querySelector('.msg-text') || {}).textContent || '';
    var role = row.classList.contains('user') ? 'You' : 'Assistant';
    var menu = document.createElement('div');
    menu.id = 'share-row-menu';
    menu.style.cssText = 'position:fixed;bottom:120px;right:50px;z-index:9999;padding:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.3);min-width:160px;';
    function addOpt(label, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'display:block;width:100%;text-align:left;padding:5px 10px;background:none;border:none;color:var(--vscode-editor-foreground);cursor:pointer;font-size:12px;border-radius:3px;';
      b.onmouseenter = function () { b.style.background = 'var(--vscode-list-hoverBackground)'; };
      b.onmouseleave = function () { b.style.background = 'none'; };
      b.addEventListener('click', function () { menu.remove(); fn(); });
      menu.appendChild(b);
    }
    addOpt('Copy as text', function () {
      try { navigator.clipboard.writeText(text); } catch (e) {}
    });
    addOpt('Copy as Markdown', function () {
      try { navigator.clipboard.writeText('**' + role + ':** ' + text); } catch (e) {}
    });
    document.body.appendChild(menu);
    setTimeout(function () {
      document.addEventListener('click', function handler(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', handler); }
      });
    }, 0);
  }

  (function () {
    var btnShare = document.getElementById('btn-share');
    if (!btnShare) return;
    btnShare.addEventListener('click', function () {
      var existing = document.getElementById('share-menu');
      if (existing) { existing.remove(); return; }
      var menu = document.createElement('div');
      menu.id = 'share-menu';
      menu.style.cssText = 'position:fixed;bottom:80px;right:50px;z-index:9999;padding:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
      function addOption(label, icon, fn) {
        var btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;padding:6px 12px;border:none;background:none;color:var(--vscode-editor-foreground);cursor:pointer;font-size:12px;border-radius:3px;text-align:left;';
        btn.innerHTML = '<span class="codicon codicon-' + icon + '"></span>' + label;
        btn.addEventListener('mouseenter', function () { btn.style.background = 'var(--vscode-list-hoverBackground)'; });
        btn.addEventListener('mouseleave', function () { btn.style.background = 'none'; });
        btn.addEventListener('click', function () { menu.remove(); fn(); });
        menu.appendChild(btn);
      }
      function getMessages() {
        var rows = messagesDiv.querySelectorAll('.msg-row');
        var msgs = [];
        rows.forEach(function (row) {
          var isUser = row.classList.contains('user');
          var text = row.querySelector('.msg-text');
          if (text) msgs.push({ role: isUser ? 'user' : 'assistant', text: text.textContent.trim() });
        });
        return msgs;
      }
      addOption('Copy as Markdown', 'markdown', function () {
        var md = getMessages().map(function (m) {
          return (m.role === 'user' ? '**You:** ' : '**Assistant:** ') + m.text;
        }).join('\n\n');
        navigator.clipboard.writeText(md).catch(function () {});
      });
      addOption('Copy as Text', 'clipboard', function () {
        var txt = getMessages().map(function (m) {
          return (m.role === 'user' ? 'You: ' : 'Assistant: ') + m.text;
        }).join('\n\n');
        navigator.clipboard.writeText(txt).catch(function () {});
      });
      addOption('Export HTML', 'file', function () {
        var cs = getComputedStyle(document.body);
        var bg = cs.backgroundColor || '#1e1e1e';
        var fg = cs.color || '#ccc';
        var font = cs.fontFamily || 'monospace';
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chat Export</title>' +
          '<style>body{background:' + bg + ';color:' + fg + ';font-family:' + font + ';padding:20px;max-width:800px;margin:0 auto;line-height:1.6;}' +
          '.msg{margin-bottom:16px;padding:8px 12px;border-radius:6px;}' +
          '.user{background:rgba(128,128,128,0.15);}' +
          '.assistant{background:rgba(128,128,128,0.05);}' +
          '.role{font-weight:bold;margin-bottom:4px;font-size:0.9em;opacity:0.7;}</style></head><body>' +
          '<h1>Chat Export</h1><p style="opacity:0.5;font-size:0.8em;">' + new Date().toLocaleString() + '</p>';
        getMessages().forEach(function (m) {
          html += '<div class="msg ' + m.role + '"><div class="role">' + (m.role === 'user' ? 'You' : 'Assistant') + '</div><div>' + m.text.replace(/</g, '&lt;') + '</div></div>';
        });
        html += '</body></html>';
        var blob = new Blob([html], { type: 'text/html' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'chat-export-' + Date.now() + '.html';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      document.body.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function handler(ev) {
          if (!menu.contains(ev.target) && ev.target !== btnShare) {
            menu.remove();
            document.removeEventListener('click', handler);
          }
        });
      }, 0);
    });
  })();

  // ── Hamburger menu share action ─────────────────────────────────────────
  window.addEventListener('junction-share-chat', function () {
    var btnShare = document.getElementById('btn-share');
    if (btnShare) btnShare.click();
  });

  // ── Maximize/pop-out button ─────────────────────────────────────────────
  (function () {
    var chatContainer = messagesDiv && messagesDiv.parentElement;
    if (!chatContainer) return;
    chatContainer.style.position = 'relative';

    var maxBtn = document.createElement('button');
    maxBtn.className = 'codicon codicon-maximize';
    maxBtn.id = 'btn-maximize-chat';
    maxBtn.title = 'Expand editor';
    maxBtn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:100;display:none;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:3px;cursor:pointer;padding:4px;color:var(--vscode-descriptionForeground);';
    chatContainer.appendChild(maxBtn);

    // Show button when scroll appears
    var scrollObserver = new MutationObserver(function () {
      if (!messagesDiv) return;
      var hasScroll = messagesDiv.scrollHeight > messagesDiv.clientHeight + 4;
      maxBtn.style.display = hasScroll ? '' : 'none';
    });
    scrollObserver.observe(messagesDiv, { childList: true, subtree: true, attributes: true });
    // Also check on scroll
    messagesDiv.addEventListener('scroll', function () {
      var hasScroll = messagesDiv.scrollHeight > messagesDiv.clientHeight + 4;
      maxBtn.style.display = hasScroll ? '' : 'none';
    });

    // Modal
    maxBtn.addEventListener('click', function () {
      var modal = document.createElement('div');
      modal.id = 'chat-expand-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';

      var panel = document.createElement('div');
      panel.style.cssText = 'width:90vw;max-width:900px;height:80vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

      // Header
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-input-border);';
      var hdrTitle = document.createElement('span');
      hdrTitle.textContent = 'Composer';
      hdrTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'codicon codicon-close';
      closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:16px;padding:0;';
      closeBtn.addEventListener('click', function () { modal.remove(); });
      hdr.appendChild(hdrTitle);
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      // Textarea
      var ta = document.createElement('textarea');
      ta.style.cssText = 'flex:1;padding:12px;border:none;background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,14px);line-height:1.6;resize:none;outline:none;';
      ta.placeholder = 'Ask agent...';
      ta.value = document.getElementById('composer-input').value;
      panel.appendChild(ta);

      // Footer
      var ftr = document.createElement('div');
      ftr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-top:1px solid var(--vscode-input-border);';
      var ftrHint = document.createElement('span');
      ftrHint.textContent = 'ESC to close · Ctrl+Enter to send';
      ftrHint.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);';
      var sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send';
      sendBtn.style.cssText = 'padding:4px 16px;border-radius:3px;border:1px solid var(--vscode-button-background);background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-size:12px;';
      sendBtn.addEventListener('click', function () {
        document.getElementById('composer-input').value = ta.value;
        document.getElementById('composer-input').dispatchEvent(new Event('input'));
        modal.remove();
        window.composerSend && window.composerSend();
      });
      ftr.appendChild(ftrHint);
      ftr.appendChild(sendBtn);
      panel.appendChild(ftr);

      modal.appendChild(panel);
      document.body.appendChild(modal);
      ta.focus();

      // ESC to close, Ctrl+Enter to send
      modal.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { modal.remove(); }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          document.getElementById('composer-input').value = ta.value;
          document.getElementById('composer-input').dispatchEvent(new Event('input'));
          modal.remove();
          window.composerSend && window.composerSend();
        }
      });
      // Click backdrop to close
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) modal.remove();
      });
    });
  })();

  // ── State ───────────────────────────────────────────────────────────────
  var activeRuns = new Map();        // runId → assistant row element
  var runSubagentInfo = new Map();   // runId → subagent metadata
  var reasoningBlocks = new Map();   // runId → <details> element
  var toolCalls = new Map();         // toolCallId → tool card element
  var toolContainers = new Map();    // runId → .tool-calls container

  // ── User rows + per-message actions ────────────────────────────────────────
  function addUserRow(text, messageId, hasCheckpoint) {
    if (isWorkspaceContext(text)) return null;
    var row = document.createElement('div');
    row.className = 'chat-row user';
    if (messageId) row.setAttribute('data-message-id', messageId);

    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    bubble.innerHTML = renderMarkdown(text);
    row.appendChild(bubble);

    if (messageId) row.appendChild(buildCheckpointMarker(messageId, hasCheckpoint));
    row.appendChild(buildMsgActions(messageId));
    messagesDiv.appendChild(row);
    forceScrollToBottom();
    return row;
  }

  function buildAssistantRow(runId, track) {
    var row = document.createElement('div');
    row.className = 'chat-row assistant';
    if (runId) row.setAttribute('data-run-id', runId);

    var reasoning = document.createElement('div');
    reasoning.className = 'reasoning-slot';
    row.appendChild(reasoning);

    // Tools FIRST (like Codex — activity before prose)
    var tools = document.createElement('div');
    tools.className = 'tool-calls';
    row.appendChild(tools);
    if (runId) toolContainers.set(runId, tools);

    // Message AFTER tools
    var bubble = document.createElement('div');
    bubble.className = 'msg-text';
    row.appendChild(bubble);

    messagesDiv.appendChild(row);
    if (track && runId) activeRuns.set(runId, row);
    return row;
  }

  function addAssistantHistoryRow(item, index) {
    var runId = item.runId || 'history:' + index;
    try {
      var row = buildAssistantRow(runId, false);
      var bubble = row.querySelector('.msg-text');
      bubble.innerHTML = renderMarkdown(item.content || '');
      if (item.thinking) {
        renderReasoning(runId, item.thinking, {
          row: row,
          complete: !!item.thinkingComplete,
          durationMs: item.thinkingDurationMs,
        });
      }
      if (item.tools && item.tools.length) {
        renderToolHistory(row, item.tools);
      }
      return row;
    } catch (e) {
      console.error('addAssistantHistoryRow failed:', e);
      return null;
    }
  }

  function buildCheckpointMarker(messageId, hasCheckpoint) {
    var marker = document.createElement('span');
    marker.className = 'checkpoint-marker' + (hasCheckpoint ? ' available' : '');
    marker.title = hasCheckpoint ? 'Checkpoint available' : 'Checkpoint pending';
    marker.dataset.messageId = messageId;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

  function buildMsgActions(messageId) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    var actions = [
      { icon: 'copy', label: 'Copy', act: 'copy' },
      { icon: 'clippy', label: 'Share', act: 'share' },
      { icon: 'history', label: 'Rewind code to here', act: 'rewind' },
      { icon: 'git-branch', label: 'Fork conversation', act: 'fork' },
      { icon: 'discard', label: 'Fork and rewind code to here', act: 'forkRewind' },
    ];
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'msg-action codicon codicon-' + a.icon;
      b.title = a.label;
      b.addEventListener('click', function () {
        if (a.act === 'copy') {
          var row = bar.parentElement;
          var t = row && row.querySelector('.msg-text');
          if (t) { try { navigator.clipboard.writeText(t.textContent || ''); } catch (e) {} }
        } else if (a.act === 'share') {
          openShareForRow(bar.parentElement);
        } else if (a.act === 'fork') {
          vscode.postMessage({ type: 'forkConversation', messageId: messageId });
        } else if (a.act === 'rewind') {
          vscode.postMessage({ type: 'rewindCode', messageId: messageId, fork: false });
        } else if (a.act === 'forkRewind') {
          vscode.postMessage({ type: 'rewindCode', messageId: messageId, fork: true });
        }
      });
      bar.appendChild(b);
    });
    return bar;
  }

  // ── Assistant rows (text + tool-call container) ─────────────────────────────
  function getOrCreateAssistantMessage(runId) {
    if (activeRuns.has(runId)) return activeRuns.get(runId);
    var info = runSubagentInfo.get(runId);
    var row = buildAssistantRow(runId, true);
    if (info) row.classList.add(info.spawnDepth > 2 ? 'subagent-deep' : 'subagent');
    if (info) applySubagentLabel(row, info);
    scrollToBottom();
    return row;
  }
  window.getOrCreateAssistantMessage = getOrCreateAssistantMessage;

  function setAssistantText(runId, fullText) {
    if (isWorkspaceContext(fullText)) return;
    var row = getOrCreateAssistantMessage(runId);
    var text = row.querySelector('.msg-text');
    if (!text) return;

    if (extraRichEnabled && fullText && fullText.length > 0) {
      // Use animated canvas for first render, then swap to DOM for interaction
      var existingCanvas = text.querySelector('.pretext-canvas');
      if (!existingCanvas && !text.dataset.settled) {
        var canvas = createAnimatedCanvas(fullText, { duration: 800 });
        if (canvas) {
          text.innerHTML = '';
          text.appendChild(canvas);
          // After animation, swap to rendered markdown
          setTimeout(function () {
            text.innerHTML = renderMarkdown(fullText);
            text.dataset.settled = '1';
          }, 850);
          ensureToolContainer(runId, row);
          scrollToBottom();
          return;
        }
      }
      // Subsequent updates — just update DOM directly
      text.innerHTML = renderMarkdown(fullText);
      text.dataset.settled = '1';
    } else {
      text.innerHTML = renderMarkdown(fullText);
    }
    ensureToolContainer(runId, row);
    scrollToBottom();
  }

  function applySubagentLabel(row, info) {
    if (row.querySelector('.subagent-label')) return;
    var label = document.createElement('div');
    label.className = 'subagent-label';
    label.textContent = '[' + (info.subagentRole || 'Subagent') + ']' +
      (info.spawnDepth ? ' (D' + info.spawnDepth + ')' : '');
    row.insertBefore(label, row.firstChild);
  }

  // ── Tool-call cards + preservation ──────────────────────────────────────────
  function ensureToolContainer(runId, row) {
    var tools = row.querySelector('.tool-calls');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      row.appendChild(tools);
    }
    toolContainers.set(runId, tools);
    return tools;
  }

  /** Truncate args for preview: first 60 chars. */
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

  /**
   * Map a raw tool call onto a Codex-style action row:
   * verb ("Edited" / "Ran" / "Read"…), target (file or command), diffstat.
   * kind drives grouping: edit | exec | explore | fetch | plan | agent | other.
   */
  function classifyTool(toolName, args) {
    var raw = String(toolName || 'tool');
    var name = raw.toLowerCase();
    var obj = parseArgsObject(args) || {};
    var file = extractFilePath(obj);
    var meta = { kind: 'other', verb: raw, target: '', plus: 0, minus: 0, mono: false };

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
    meta.target = truncateArgs(meta.target);
    return meta;
  }

  /** Build a slim expandable action row for one tool call. */
  function buildToolRow(tool) {
    var meta = classifyTool(tool.toolName, tool.args);
    var details = document.createElement('details');
    details.className = 'tool-row';
    details.setAttribute('data-kind', meta.kind);
    details.setAttribute('data-target', meta.target);
    var statusClass = tool.isError ? 'error' : (tool.phase === 'result' ? 'done' : 'running');
    var diffHtml = '';
    if (meta.plus || meta.minus) {
      diffHtml = '<span class="tool-diff">' +
        (meta.plus ? '<span class="diff-plus">+' + meta.plus + '</span>' : '') +
        (meta.minus ? '<span class="diff-minus">-' + meta.minus + '</span>' : '') +
        '</span>';
    }
    details.innerHTML =
      '<summary class="tool-row-summary">' +
        '<span class="tool-row-status ' + statusClass + '" aria-hidden="true">' +
          (statusClass === 'running' ? '<span class="codicon codicon-loading codicon-modifier-spin"></span>' : '') +
        '</span>' +
        '<span class="tool-verb">' + escapeHtml(meta.verb) + '</span>' +
        (meta.target ? '<span class="tool-target' + (meta.mono ? ' mono' : '') + '">' + escapeHtml(meta.target) + '</span>' : '') +
        diffHtml +
        '<span class="codicon codicon-chevron-right tool-chevron" aria-hidden="true"></span>' +
      '</summary>' +
      '<div class="tool-detail"></div>';
    var detail = details.querySelector('.tool-detail');
    var argsText = stringifyArgs(tool.args);
    if (argsText && argsText !== '{}') {
      detail.appendChild(buildDetailSection('Input', argsText));
    }
    if (tool.updates) detail.appendChild(buildDetailSection('Log', tool.updates));
    if (tool.result) detail.appendChild(buildDetailSection('Output', formatToolOutput(tool.result)));
    return details;
  }

  function buildDetailSection(label, text, lang) {
    var section = document.createElement('div');
    section.className = 'tool-detail-section';
    section.setAttribute('data-section', label.toLowerCase());

    var isJson = false;
    var trimmed = String(text || '').trim();
    if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 2) {
      try {
        JSON.parse(trimmed);
        isJson = true;
      } catch (e) {}
    }

    var displayLang = lang;
    if (isJson) displayLang = 'json';

    // Code editor container
    var editor = document.createElement('div');
    editor.className = 'code-editor';

    // Header bar: label + language + copy button
    var header = document.createElement('div');
    header.className = 'code-editor-header';
    header.innerHTML =
      '<span class="code-editor-label">' + escapeHtml(label) + '</span>' +
      (displayLang ? '<span class="code-editor-lang">' + escapeHtml(displayLang) + '</span>' : '') +
      '<button class="code-editor-copy" title="Copy">' +
        '<span class="codicon codicon-copy"></span>' +
      '</button>';

    // Copy button handler
    var copyBtn = header.querySelector('.code-editor-copy');
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.innerHTML = '<span class="codicon codicon-check"></span>';
        setTimeout(function () { copyBtn.innerHTML = '<span class="codicon codicon-copy"></span>'; }, 1500);
      });
    });

    // Code content
    var body = document.createElement('div');
    body.className = 'code-editor-body';
    var code = document.createElement('pre');
    code.className = 'code-editor-code';
    if (isJson) {
      code.innerHTML = syntaxHighlightJson(text);
    } else if (label === 'Log') {
      code.textContent = text;
    } else {
      code.innerHTML = simpleHighlight(text, lang || 'javascript');
    }
    body.appendChild(code);

    editor.appendChild(header);
    editor.appendChild(body);
    section.appendChild(editor);
    return section;
  }

  function setToolRowStatus(row, statusClass) {
    var status = row.querySelector('.tool-row-status');
    if (!status) return;
    status.classList.remove('running', 'done', 'error');
    status.classList.add(statusClass);
    status.innerHTML = '';
  }

  function handleToolStart(ev) {
    var row = getOrCreateAssistantMessage(ev.runId);
    var tools = ensureToolContainer(ev.runId, row);
    var toolName = ev.toolName || '';
    if (!toolName) return;
    var args = ev.args || '';
    if (args === '{}' || args === 'undefined') args = '';
    var existing = toolCalls.get(ev.toolCallId);
    if (existing) {
      var rebuilt = buildToolRow({ toolName: toolName, args: args, phase: 'start' });
      rebuilt.id = existing.id || ('tool-' + ev.toolCallId);
      existing.replaceWith(rebuilt);
      toolCalls.set(ev.toolCallId, rebuilt);
      return;
    }
    var card = buildToolRow({ toolName: toolName, args: args, phase: 'start' });
    card.id = 'tool-' + ev.toolCallId;
    tools.appendChild(card);
    toolCalls.set(ev.toolCallId, card);
    scrollToBottom();
  }

  function renderToolHistory(row, tools) {
    if (!tools || !tools.length) return;
    var container = ensureToolContainer(row.getAttribute('data-run-id') || 'history-tools', row);
    tools.forEach(function (tool) {
      var toolName = tool.toolName || '';
      if (!toolName) return;
      // History rows render as finished even if the result event was lost.
      var card = buildToolRow({
        toolName: toolName,
        args: tool.args,
        updates: tool.updates,
        result: tool.result,
        isError: tool.isError,
        phase: 'result',
      });
      container.appendChild(card);
      if (tool.toolCallId) toolCalls.set(tool.toolCallId, card);
    });
    groupToolRows(container);
  }

  function handleToolUpdate(ev) {
    var card = toolCalls.get(ev.toolCallId);
    if (!card) return;
    var detail = card.querySelector('.tool-detail');
    if (!detail) return;
    var log = detail.querySelector('[data-section="log"]');
    if (!log) {
      log = buildDetailSection('Log', '');
      detail.appendChild(log);
    }
    var pre = log.querySelector('pre');
    if (pre) pre.textContent = (pre.textContent || '') + (ev.text || '');
    scrollToBottom();
  }

  function handleToolResult(ev) {
    var card = toolCalls.get(ev.toolCallId);
    if (!card) return;
    setToolRowStatus(card, ev.isError ? 'error' : 'done');
    var out = formatToolOutput(ev.result);
    if (out) {
      var detail = card.querySelector('.tool-detail');
      if (detail) {
        var section = detail.querySelector('[data-section="output"]');
        if (!section) {
          detail.appendChild(buildDetailSection('Output', out));
        } else {
          var code = section.querySelector('pre');
          var lineNums = section.querySelector('.code-editor-lines');
          if (code) {
            var isJson = false;
            var trimmed = out.trim();
            if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 2) {
              try {
                JSON.parse(trimmed);
                isJson = true;
              } catch (e) {}
            }
            if (isJson) {
              code.innerHTML = syntaxHighlightJson(out);
            } else {
              code.innerHTML = simpleHighlight(out, 'javascript');
            }
          }
          if (lineNums) {
            lineNums.innerHTML = '';
            var lines = out.split('\n');
            for (var i = 1; i <= lines.length; i++) {
              var ln = document.createElement('span');
              ln.className = 'code-editor-line-num';
              ln.textContent = i;
              lineNums.appendChild(ln);
            }
          }
        }
      }
    }
    scrollToBottom();
  }

  // ── Activity-stream look & feel (junction.activityStream.*) ───────────────
  //   layout: accordion (Codex fold) | timeline (Claude rail) | hybrid (both)
  //   rail:   vertical guide line on/off
  //   dots:   status (colored, blink while running) | minimal (neutral+spinner)
  var streamCfg = { layout: 'accordion', rail: true, dots: 'status' };

  function applyStreamConfig() {
    var b = document.body;
    b.classList.remove(
      'stream-layout-accordion', 'stream-layout-timeline', 'stream-layout-hybrid',
      'stream-rail', 'stream-dots-status', 'stream-dots-minimal'
    );
    b.classList.add('stream-layout-' + streamCfg.layout);
    if (streamCfg.rail) b.classList.add('stream-rail');
    b.classList.add('stream-dots-' + streamCfg.dots);
  }
  applyStreamConfig();

  // ── Codex-style grouping: one accordion per turn, combined summary ────────
  // Mirrors the Codex extension's activity-slice logic: all finished activity
  // rows of a turn fold into one <details> whose summary aggregates counts —
  // "Edited 2 files, explored 5 files, 3 searches, ran 4 commands".
  var GROUPABLE_KINDS = { edit: 1, exec: 1, explore: 1, fetch: 1 };

  /**
   * Classify a shell command the way Codex parses exec calls: reads, searches
   * and listings count as exploration, everything else is a real command.
   */
  function classifyCommand(cmd) {
    var c = String(cmd || '').trim();
    // Skip leading `cd … &&` / `cd …;` hops
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

  /** Aggregate rows into the Codex combined label (first segment capitalized). */
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
      } else if (kind === 'fetch') {
        webSearches++;
      } else {
        calls++;
      }
    });
    var segs = [];
    function seg(count, cap, low, one, many) {
      if (!count) return;
      segs.push((segs.length === 0 ? cap : low) + ' ' + count + ' ' + (count === 1 ? one : many));
    }
    function size(obj) { return Object.keys(obj).length; }
    seg(size(created), 'Created', 'created', 'file', 'files');
    seg(size(edited), 'Edited', 'edited', 'file', 'files');
    var exploreBits = [];
    if (size(explored)) exploreBits.push(size(explored) + (size(explored) === 1 ? ' file' : ' files'));
    if (searches) exploreBits.push(searches + (searches === 1 ? ' search' : ' searches'));
    if (lists) exploreBits.push(lists + (lists === 1 ? ' list' : ' lists'));
    if (exploreBits.length) {
      segs.push((segs.length === 0 ? 'Explored' : 'explored') + ' ' + exploreBits.join(', '));
    }
    seg(commands, 'Ran', 'ran', 'command', 'commands');
    seg(webSearches, 'Searched web', 'searched web', 'time', 'times');
    seg(calls, 'Called', 'called', 'tool', 'tools');
    return segs.length ? segs.join(', ') : 'Tool activity';
  }

  /**
   * Fold all finished groupable rows of a container into one collapsed
   * accordion. Running rows and non-groupable kinds (plan/agent/other) stay
   * visible at top level. Safe to call repeatedly: existing groups dissolve
   * first so counts are recomputed over the whole turn.
   */
  function groupToolRows(container) {
    if (!container) return;
    Array.prototype.slice.call(container.querySelectorAll(':scope > .tool-group')).forEach(function (group) {
      var body = group.querySelector('.tool-group-body');
      if (body) {
        while (body.firstChild) container.insertBefore(body.firstChild, group);
      }
      group.remove();
    });
    // Timeline layout never folds — rows stay inline on the rail.
    if (streamCfg.layout === 'timeline') return;
    var groupable = Array.prototype.slice.call(container.children).filter(function (node) {
      if (!node.classList || !node.classList.contains('tool-row')) return false;
      if (node.querySelector('.tool-row-status.running')) return false;
      return !!GROUPABLE_KINDS[node.getAttribute('data-kind')];
    });
    if (groupable.length < 2) return;

    var hasError = groupable.some(function (r) { return r.querySelector('.tool-row-status.error'); });
    var group = document.createElement('details');
    group.className = 'tool-group';
    var summary = document.createElement('summary');
    summary.className = 'tool-row-summary tool-group-summary';
    summary.innerHTML =
      '<span class="tool-row-status ' + (hasError ? 'error' : 'done') + '" aria-hidden="true"></span>' +
      '<span class="tool-group-title">' + escapeHtml(activitySummaryLabel(groupable)) + '</span>' +
      '<span class="codicon codicon-chevron-right tool-chevron" aria-hidden="true"></span>';
    var body = document.createElement('div');
    body.className = 'tool-group-body';
    container.insertBefore(group, groupable[0]);
    group.appendChild(summary);
    group.appendChild(body);
    groupable.forEach(function (r) { r.open = false; body.appendChild(r); });
  }

  function formatToolOutput(result) {
    if (result == null) return '';
    if (typeof result !== 'string') {
      try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); }
    }
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

  // Re-attach a tool container if a text re-render ever detaches it.
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.removedNodes.length; j++) {
        var node = m.removedNodes[j];
        if (node.nodeType === 1 && node.classList && node.classList.contains('tool-calls')) {
          activeRuns.forEach(function (row, runId) {
            if (!row.querySelector('.tool-calls') && toolContainers.has(runId)) {
              row.appendChild(toolContainers.get(runId));
            }
          });
        }
      }
    }
  });
  observer.observe(messagesDiv, { childList: true, subtree: true });

  // ── Reasoning disclosures ───────────────────────────────────────────────────
  // Two modes (openclaw.reasoningDisplay):
  //   'expanded' — stream the reasoning expanded, auto-collapse on finish.
  //   'compact'  — collapsed "Thinking… ~N tokens" live ticker,
  //                reveal the block (expandable) after it finishes.
  var reasoningMode = 'compact';

  function approxTokens(text) { return Math.max(1, Math.round((text || '').length / 4)); }

  // Zalgo character sets for the rising animation
  var ZALGO_UP = ['̍','̎','̄','̅','̿','̑','̐','̒','̓','̔','̽','̾','̿','̀','́','̂','̃','̄','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐','̒','̓','̔','̕','̖','̗','̘','̙','̜','̝','̞','̟','̠','̡','̢','̣','̤','̥','̦','̧','̨','̩','̪','̫','̬','̭','̮','̯','̰','̱','̲','̳','̹','̺','̻','̼','̽','̾','̿','̀','́','̂','̃','̄','̅','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐','̒'];
  var ZALGO_MID = ['̴','̵','̶','̷','̸'];
  var THINKING_BAR_COLS = 16;
  var THINKING_BAR_HEIGHT = 3; // rows of rising chars
  var THINKING_BAR_UPDATE_MS = 280; // debounce between updates

  function thinkingBarHtml() {
    var cols = '';
    for (var c = 0; c < THINKING_BAR_COLS; c++) {
      var delay = (c * 37) % 200;
      var cells = '';
      for (var r = 0; r < THINKING_BAR_HEIGHT; r++) {
        cells += '<span class="thinking-bar-cell" style="opacity:0"></span>';
      }
      cols += '<div class="thinking-bar-col" style="animation-delay:' + delay + 'ms">' + cells + '</div>';
    }
    var line = '';
    for (var i = 0; i < THINKING_BAR_COLS; i++) line += '\u2500'; // ─ light horizontal
    return '<div class="thinking-bar" data-active="false">' +
      '<div class="thinking-bar-cols">' + cols + '</div>' +
      '<div class="thinking-bar-line">' + line + '</div>' +
    '</div>';
  }

  /** Random zalgo char from a set. */
  function zalgoRandom(set) { return set[Math.floor(Math.random() * set.length)]; }

  /** Generate a single zalgo character (combining marks). */
  function zalgoChar() {
    var base = String.fromCharCode(0x30 + Math.floor(Math.random() * 42)); // digits + some symbols
    var count = 1 + Math.floor(Math.random() * 2);
    var marks = '';
    for (var i = 0; i < count; i++) marks += zalgoRandom(ZALGO_UP);
    return base + marks;
  }

  /** Update a single thinking-bar: rise characters up, cycle top row. */
  function tickThinkingBar(bar) {
    if (!bar || bar.dataset.active === 'done') return;
    var cols = bar.querySelectorAll('.thinking-bar-col');
    cols.forEach(function (col, ci) {
      var cells = col.querySelectorAll('.thinking-bar-cell');
      // Shift cells up: cell[i] gets cell[i+1]'s content
      for (var i = 0; i < cells.length - 1; i++) {
        cells[i].textContent = cells[i + 1].textContent;
        cells[i].style.opacity = cells[i + 1].textContent ? (0.3 + 0.7 * (i / cells.length)).toFixed(2) : '0';
        cells[i].style.filter = 'blur(' + (Math.max(0, cells.length - i - 2) * 0.4) + 'px)';
      }
      // Top cell gets a new random zalgo char (or empty to create gaps)
      var topCell = cells[cells.length - 1];
      if (Math.random() < 0.65) {
        topCell.textContent = zalgoChar();
        topCell.style.opacity = '0.9';
        topCell.style.filter = 'blur(0px)';
      } else {
        topCell.textContent = '';
        topCell.style.opacity = '0';
      }
    });
  }

  function startThinkingBar(bar) {
    if (!bar) return;
    bar.dataset.active = 'running';
    // Initial fill
    bar.querySelectorAll('.thinking-bar-col').forEach(function (col) {
      col.querySelectorAll('.thinking-bar-cell').forEach(function (cell) {
        if (Math.random() < 0.4) {
          cell.textContent = zalgoChar();
          cell.style.opacity = (0.2 + Math.random() * 0.6).toFixed(2);
        }
      });
    });
    scheduleBarTick(bar);
  }

  function stopThinkingBar(bar) {
    if (!bar) return;
    bar.dataset.active = 'done';
    bar.querySelectorAll('.thinking-bar-cell').forEach(function (cell) {
      cell.textContent = '';
      cell.style.opacity = '0';
    });
  }

  /** Throttle tickThinkingBar to THINKING_BAR_UPDATE_MS per bar. */
  var _barTimers = new Map();
  function scheduleBarTick(bar) {
    if (_barTimers.has(bar)) return;
    _barTimers.set(bar, setTimeout(function () {
      _barTimers.delete(bar);
      if (bar.dataset.active === 'running') {
        tickThinkingBar(bar);
        scheduleBarTick(bar);
      }
    }, THINKING_BAR_UPDATE_MS));
  }

  function summaryHtml(label, opts) {
    opts = opts || {};
    var bar = opts.showBar ? thinkingBarHtml() : '';
    return (opts.showBar ? '' : '<span class="thinking-throbber" aria-hidden="true"></span>') +
      bar +
      '<span class="reasoning-label">' + escapeHtml(label) + '</span>' +
      '<span class="codicon codicon-chevron-right thinking-toggle" aria-hidden="true"></span>';
  }

  function ensureReasoningSlot(row) {
    var slot = row.querySelector('.reasoning-slot');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'reasoning-slot';
      row.insertBefore(slot, row.querySelector('.msg-text') || row.firstChild);
    }
    return slot;
  }

  function renderReasoning(runId, fullText, opts) {
    opts = opts || {};
    var row = opts.row || getOrCreateAssistantMessage(runId);
    var slot = ensureReasoningSlot(row);
    var block = reasoningBlocks.get(runId);
    var isActive = !opts.complete;
    if (!block) {
      block = document.createElement('details');
      block.className = 'reasoning-disclosure thinking';
      // History rows (opts.row) and finished thinking start collapsed;
      // live streaming honours the reasoningDisplay mode.
      block.open = (opts.row || opts.complete) ? false : (reasoningMode !== 'compact');
      block.innerHTML = '<summary>' + summaryHtml('', { showBar: isActive }) + '</summary>' +
        '<div class="reasoning-content"></div>';
      slot.appendChild(block);
      reasoningBlocks.set(runId, block);
    }
    var label = opts.complete
      ? finalReasoningLabel(fullText, opts.durationMs)
      : (reasoningMode === 'compact')
      ? 'Thinking… ~' + approxTokens(fullText).toLocaleString() + ' tokens'
      : 'Reasoning…';
    block.classList.toggle('thinking', isActive);
    var summary = block.querySelector('summary');
    var labelEl = summary.querySelector('.reasoning-label');
    var existingBar = summary.querySelector('.thinking-bar');

    if (!existingBar && isActive) {
      // (Re)entering thinking with no bar — build summary with bar and start it.
      summary.innerHTML = summaryHtml(label, { showBar: true });
      var bar = block.querySelector('.thinking-bar');
      if (bar) {
        startThinkingBar(bar);
        scheduleBarTick(bar);
      }
      // Persist active run for webview reload
      messagesDiv.dataset.activeRun = runId;
      messagesDiv.dataset.activeRunTime = Date.now();
    } else if (existingBar && !isActive) {
      // Thinking finished — replace summary without bar
      summary.innerHTML = summaryHtml(label, { showBar: false });
      if (messagesDiv.dataset.activeRun === runId) {
        delete messagesDiv.dataset.activeRun;
        delete messagesDiv.dataset.activeRunTime;
      }
    } else if (existingBar && isActive) {
      // Ongoing thinking — keep the bar alive. The initial render lands here
      // (block innerHTML already contains an idle bar), so start it if needed.
      if (existingBar.dataset.active !== 'running') {
        startThinkingBar(existingBar);
        scheduleBarTick(existingBar);
      }
      if (labelEl) labelEl.textContent = label;
    } else if (labelEl) {
      labelEl.textContent = label;
    } else {
      // Fallback: replace summary
      summary.innerHTML = summaryHtml(label, { showBar: isActive });
    }
    var contentEl = block.querySelector('.reasoning-content');
    contentEl.innerHTML = formatThinkingContent(fullText || '');
    scrollToBottom();
  }

  /** Format thinking content — pretty-print JSON, render plain text nicely. */
  function formatThinkingContent(text) {
    if (!text) return '';
    var trimmed = text.trim();
    // Try to parse as JSON
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !trimmed.includes('\n')) {
      try {
        var obj = JSON.parse(trimmed);
        return '<pre class="thinking-json">' + syntaxHighlightJson(JSON.stringify(obj, null, 2)) + '</pre>';
      } catch (e) { /* not JSON, fall through */ }
    }
    // Multi-line JSON blocks (tool calls, structured data)
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        var obj2 = JSON.parse(trimmed);
        return '<pre class="thinking-json">' + syntaxHighlightJson(JSON.stringify(obj2, null, 2)) + '</pre>';
      } catch (e) { /* not valid JSON */ }
    }
    // Plain text — render with line breaks
    return '<div class="thinking-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
  }

  /** Syntax-highlight a JSON string with span classes. */
  function syntaxHighlightJson(json) {
    return escapeHtml(json)
      .replace(/&quot;([^&]*?)&quot;\s*:/g, '<span class="json-key">&quot;$1&quot;</span>:')
      .replace(/:\s*&quot;([^&]*?)&quot;/g, ': <span class="json-string">&quot;$1&quot;</span>')
      .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
  }

  function finalReasoningLabel(fullText, durationMs) {
    var secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
    var toks = approxTokens(fullText);
    return (secs ? 'Thought for ' + secs + 's' : 'Thought') + ' · ~' + toks.toLocaleString() + ' tokens';
  }

  function finalizeReasoning(runId, durationMs) {
    var block = reasoningBlocks.get(runId);
    if (!block) return;
    var content = block.querySelector('.reasoning-content');
    var label = finalReasoningLabel(content ? content.textContent : '', durationMs);
    block.classList.remove('thinking');
    // Stop the bar animation
    var bar = block.querySelector('.thinking-bar');
    if (bar) stopThinkingBar(bar);
    block.querySelector('summary').innerHTML = summaryHtml(label);
    // expanded mode auto-collapses; compact stays collapsed but expandable.
    block.open = false;
    // Clear persisted active run
    if (messagesDiv.dataset.activeRun === runId) {
      delete messagesDiv.dataset.activeRun;
      delete messagesDiv.dataset.activeRunTime;
    }
  }

  // ── Working indicator (run active, Codex-style shimmer) ───────────────────
  var workingRow = null;
  function setWorking(active) {
    if (active) {
      if (!workingRow) {
        workingRow = document.createElement('div');
        workingRow.className = 'working-row';
      } else {
        var oldCanvas = workingRow.querySelector('canvas.pretext-canvas');
        if (oldCanvas && typeof oldCanvas._stopAnimation === 'function') {
          oldCanvas._stopAnimation();
        }
      }
      
      // Calculate width to stretch the whole window
      var w = Math.max(300, messagesDiv.clientWidth - 24);
      var fontSize = parseInt(getComputedStyle(document.body).fontSize) || 13;
      var charWidth = fontSize * 0.6;
      var lineCharCount = Math.max(10, Math.floor(w / charWidth));
      var lineStr = '';
      for (var i = 0; i < lineCharCount; i++) lineStr += '\u2500';

      // Create looping canvas animation at full width
      var canvas = createAnimatedCanvas(lineStr, { loader: true, width: w });
      if (canvas) {
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.margin = '0 auto';
        workingRow.innerHTML = '';
        workingRow.appendChild(canvas);
      } else {
        workingRow.innerHTML = '<span class="working-shimmer">Working…</span>';
      }

      workingRow.classList.remove('suppressed');
      messagesDiv.appendChild(workingRow);
      scrollToBottom();
    } else if (workingRow) {
      var oldCanvas = workingRow.querySelector('canvas.pretext-canvas');
      if (oldCanvas && typeof oldCanvas._stopAnimation === 'function') {
        oldCanvas._stopAnimation();
      }
      workingRow.remove();
    }
  }
  window.refreshWorking = function () {
    if (workingRow && workingRow.isConnected && !workingRow.classList.contains('suppressed')) {
      setWorking(true);
    }
  };
  /** Keep the indicator pinned below the newest content. */
  function pinWorkingRow() {
    if (workingRow && workingRow.isConnected && messagesDiv.lastElementChild !== workingRow) {
      messagesDiv.appendChild(workingRow);
    }
  }
  /** Hide while the thinking bar animates (avoid double indicators). */
  function suppressWorking(suppress) {
    if (workingRow) workingRow.classList.toggle('suppressed', !!suppress);
  }

  // ── History / response ──────────────────────────────────────────────────────
  function clearMessages() {
    messagesDiv.innerHTML = '';
    activeRuns.clear();
    runSubagentInfo.clear();
    reasoningBlocks.clear();
    toolCalls.clear();
    toolContainers.clear();
    _barTimers.forEach(function (t) { clearTimeout(t); });
    _barTimers.clear();
  }

  var WORKSPACE_PREFIXES = ['Chat: VS Code.', 'This session is driven', '[Workspace File Context]', '[Attached Context]'];
  var WORKSPACE_MARKERS = ['treat paths as relative to workspace'];

  function isWorkspaceContext(text) {
    if (!text) return false;
    var t = text.trim();
    if (WORKSPACE_PREFIXES.some(function (p) { return t.startsWith(p); })) return true;
    if (WORKSPACE_MARKERS.some(function (m) { return t.includes(m); })) return true;
    return false;
  }

  function renderHistory(history) {
    clearMessages();
    (history || []).forEach(function (item, index) {
      if (!item) return;
      // Filter out gateway-injected workspace context messages
      if (isWorkspaceContext(item.content)) return;
      if (item.role === 'assistant') {
        if (!item.content && !item.thinking && !(item.tools && item.tools.length)) return;
        addAssistantHistoryRow(item, index);
      } else {
        if (!item.content) return;
        addUserRow(item.content, item.messageId, item.hasCheckpoint);
      }
    });
    // Restart thinking bar for active run if persisted across reload
    var activeRunId = messagesDiv.dataset.activeRun;
    if (activeRunId) {
      var block = reasoningBlocks.get(activeRunId);
      if (block) {
        var bar = block.querySelector('.thinking-bar');
        if (bar && bar.dataset.active !== 'running') {
          startThinkingBar(bar);
          scheduleBarTick(bar);
        }
        block.classList.add('thinking');
        block.open = (reasoningMode !== 'compact');
      }
    }
    forceScrollToBottom();
  }
  window.renderHistory = renderHistory;

  // ── Inbound dispatch ────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'clearChat':
        clearMessages();
        break;
      case 'config':
        if (msg.reasoningDisplay) reasoningMode = msg.reasoningDisplay;
        if (msg.extraRichText !== undefined) extraRichEnabled = !!msg.extraRichText;
        if (msg.activityLayout) streamCfg.layout = msg.activityLayout;
        if (msg.activityRail !== undefined) streamCfg.rail = !!msg.activityRail;
        if (msg.activityDots) streamCfg.dots = msg.activityDots;
        applyStreamConfig();
        break;
      case 'history':
        renderHistory(msg.messages);
        break;
      case 'userEcho':
        if (!isWorkspaceContext(msg.text)) {
          addUserRow(msg.text, msg.messageId, msg.hasCheckpoint);
        }
        break;
      case 'checkpointReady':
        var marker = messagesDiv.querySelector('.checkpoint-marker[data-message-id="' + msg.messageId + '"]');
        if (marker) {
          marker.classList.add('available');
          marker.title = 'Checkpoint available';
        }
        break;
      case 'response':
        if (!isWorkspaceContext(msg.text)) {
          setAssistantText('response', msg.text);
        }
        activeRuns.delete('response');
        break;
      case 'assistant_stream_start':
        getOrCreateAssistantMessage(msg.runId);
        break;
      case 'assistant_stream_delta':
        if (msg.fullText !== undefined && !isWorkspaceContext(msg.fullText)) {
          setAssistantText(msg.runId, msg.fullText);
        }
        break;
      case 'assistant_stream_end':
        activeRuns.delete(msg.runId);
        // Turn finished — fold this run's actions into Codex-style accordions.
        groupToolRows(toolContainers.get(msg.runId));
        break;
      case 'runActive':
        setWorking(!!msg.active);
        break;
      case 'thinking_chunk':
        renderReasoning(msg.runId, msg.fullText);
        suppressWorking(true);
        break;
      case 'thinking_end':
        finalizeReasoning(msg.runId, msg.durationMs);
        suppressWorking(false);
        break;
      case 'tool_start':
        handleToolStart(msg);
        break;
      case 'tool_update':
        handleToolUpdate(msg);
        break;
      case 'tool_result':
        handleToolResult(msg);
        break;
      case 'subagentInfo':
        runSubagentInfo.set(msg.runId, msg);
        var row = activeRuns.get(msg.runId);
        if (row) {
          applySubagentLabel(row, msg);
          row.classList.add(msg.spawnDepth > 2 ? 'subagent-deep' : 'subagent');
        }
        break;
      case 'tokenUsage':
        var r = activeRuns.get(msg.runId);
        if (r) {
          var footer = r.querySelector('.token-footer');
          if (!footer) {
            footer = document.createElement('div');
            footer.className = 'token-footer';
            r.appendChild(footer);
          }
          footer.textContent = '↑ ' + (msg.inputTokens || 0).toLocaleString() +
            '  ↓ ' + (msg.outputTokens || 0).toLocaleString();
        }
        break;
    }
    pinWorkingRow();
  });

  // ── File link click handler ────────────────────────────────────────────────
  messagesDiv.addEventListener('click', function (e) {
    var target = e.target.closest('.file-link');
    if (!target) return;
    var filePath = target.getAttribute('data-file');
    if (filePath) {
      vscode.postMessage({ type: 'openFile', filePath: filePath });
    }
  });

  // ── Global Canvas Text Renderer ──────────────────────────────────────────
  function bindTextareaToCanvas(textarea) {
    if (!textarea || textarea.dataset.hasCanvas) return;
    textarea.dataset.hasCanvas = 'true';

    // Make textarea text transparent, keep caret visible
    textarea.style.color = 'transparent';
    textarea.style.caretColor = 'var(--vscode-foreground, currentColor)';
    textarea.style.background = 'transparent';

    var parent = textarea.parentNode;
    var parentStyle = getComputedStyle(parent);
    if (parentStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas static-text textarea-canvas';
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none'; // click goes through to textarea
    canvas.style.zIndex = '0'; // place behind text cursor but above background
    parent.appendChild(canvas);

    function updateCanvas() {
      var font = getComputedStyle(textarea).font;
      var realColor = getComputedStyle(parent).color || getComputedStyle(document.body).color || '#ccc';
      var text = textarea.value || textarea.placeholder || '';
      var fontHeight = parseFloat(getComputedStyle(textarea).fontSize) || 13;
      var paddingLeft = parseFloat(getComputedStyle(textarea).paddingLeft) || 4;
      var paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 4;

      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.font = font;

      var dpr = window.devicePixelRatio || 1;
      var w = textarea.offsetWidth;
      var h = textarea.offsetHeight;
      var left = textarea.offsetLeft;
      var top = textarea.offsetTop;

      if (w <= 0 || h <= 0) return;

      canvas.style.left = left + 'px';
      canvas.style.top = top + 'px';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';

      canvas.width = w * dpr;
      canvas.height = h * dpr;

      ctx.scale(dpr, dpr);
      ctx.font = font;
      ctx.fillStyle = textarea.value ? realColor : 'rgba(128, 128, 128, 0.5)'; // placeholder color if empty
      ctx.textBaseline = 'top';

      var lines = [];
      if (PretextAPI && PretextAPI.prepareWithSegments && PretextAPI.layoutWithLines) {
        try {
          var prepared = PretextAPI.prepareWithSegments(text, font);
          var layoutResult = PretextAPI.layoutWithLines(prepared, w - paddingLeft * 2, fontHeight * 1.4);
          lines = (layoutResult.lines || []).map(function (l) { return l.text || l; });
        } catch (e) {
          lines = text.split('\n');
        }
      } else {
        lines = text.split('\n');
      }

      lines.forEach(function (line, idx) {
        ctx.fillText(line, paddingLeft, paddingTop + idx * fontHeight * 1.4 - textarea.scrollTop);
      });
    }

    textarea.addEventListener('input', updateCanvas);
    textarea.addEventListener('scroll', updateCanvas);
    textarea.addEventListener('keyup', updateCanvas);
    textarea.addEventListener('keydown', updateCanvas);
    textarea.addEventListener('change', updateCanvas);
    textarea.addEventListener('focus', updateCanvas);
    textarea.addEventListener('blur', updateCanvas);

    var resizeTimeout = null;
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        if (resizeTimeout) cancelAnimationFrame(resizeTimeout);
        resizeTimeout = requestAnimationFrame(updateCanvas);
      });
      ro.observe(textarea);
    } else {
      textarea.addEventListener('resize', updateCanvas);
    }

    setTimeout(updateCanvas, 50);
  }

  function convertTextNodeToCanvas(textNode) {
    if (!textNode || !textNode.parentNode) return;
    var text = textNode.nodeValue;
    if (!text || !text.trim()) return; // skip empty or whitespace-only nodes

    var parent = textNode.parentNode;
    var parentTag = parent.tagName.toLowerCase();
    if (parentTag === 'script' || parentTag === 'style' || parentTag === 'canvas' ||
        parentTag === 'textarea' || parentTag === 'input' || parent.classList.contains('pretext-canvas') ||
        parent.classList.contains('code-editor-line-num')) {
      return;
    }

    var font = getComputedStyle(parent).font;
    var color = getComputedStyle(parent).color;
    var fontSize = parseFloat(getComputedStyle(parent).fontSize) || 13;
    var lineHeight = parseFloat(getComputedStyle(parent).lineHeight) || (fontSize * 1.5);

    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas static-text';
    canvas.dataset.originalText = text;

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = font;

    var dpr = window.devicePixelRatio || 1;
    var tw = Math.ceil(ctx.measureText(text).width) + 2;
    var th = Math.ceil(lineHeight) + 2;

    canvas.width = tw * dpr;
    canvas.height = th * dpr;
    canvas.style.width = tw + 'px';
    canvas.style.height = th + 'px';
    canvas.style.display = 'inline-block';
    canvas.style.verticalAlign = 'baseline';

    ctx.scale(dpr, dpr);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 1, th / 2);

    parent.replaceChild(canvas, textNode);
  }

  function convertDocumentToCanvas() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    var nodes = [];
    while (node = walker.nextNode()) {
      nodes.push(node);
    }
    nodes.forEach(function (n) {
      convertTextNodeToCanvas(n);
    });

    document.querySelectorAll('textarea').forEach(function (t) {
      bindTextareaToCanvas(t);
    });
  }

  // Run on startup
  if (document.body) {
    convertDocumentToCanvas();
  } else {
    document.addEventListener('DOMContentLoaded', convertDocumentToCanvas);
  }

  // Intercept all future DOM mutations
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          convertTextNodeToCanvas(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName && node.tagName.toLowerCase() === 'textarea') {
            bindTextareaToCanvas(node);
          }
          var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
          var childTextNode;
          var childTextNodes = [];
          while (childTextNode = walker.nextNode()) {
            childTextNodes.push(childTextNode);
          }
          childTextNodes.forEach(function (n) {
            convertTextNodeToCanvas(n);
          });
          node.querySelectorAll('textarea').forEach(function (t) {
            bindTextareaToCanvas(t);
          });
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
