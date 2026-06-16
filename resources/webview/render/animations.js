/* ==========================================================================
   animations.js — Pretext canvas animation renderer (matrix, zalgo, fire,
                    bounce, spiral, galaxy, leak, matrix-loader, fly-anim)
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv_a = document.getElementById('chat-messages');
  var matrixChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,.<>?/~`';
  var splashCharsets = {
    matrix: matrixChars,
    latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    katakana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
    hiragana: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    cjk: '天地玄黄宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏龍虎山川風火雷電零壹貳參肆伍陸柒捌玖拾',
    hangul: '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허',
    binary: '010101110011001011010101',
    symbols: '@#$%^&*()_+-=[]{}<>/\\\\|;:,.~`'
  };
  var PretextAPI = window.Pretext || null;
  var extraRichEnabled = true; // default on
  var ZALGO_SPLASH_MARKS = ['̍','̎','̄','̅','̿','̑','̐','̒','̓','̔','̽','̾','̀','́','̂','̃','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐'];

  /** Get font string from computed style. */
  function getCurrentFont() {
    var s = getComputedStyle(document.body);
    return (s.fontWeight || '400') + ' ' + (s.fontSize || '13px') + ' ' + (s.fontFamily || 'monospace');
  }

  // ── Animation control defaults ──────────────────────────────────────────────
  var animConfig = {
    speed: 1.0,    fontSize: 1.0, density: 1.0, intensity: 1.0,
    loop: false,   length: 2.0,
    bgColor: 'theme', bgAlpha: 0.0,
    widthMode: 'full', sizeOff: false, magic: false, curtainFade: 0.3,
    loaderMode: 'default',
    diffusionHeight: 1.0, noiseRes: 4, textFade: 0.5, cooling: 0.65, spread: 0.3,
    loaderSpeed: 1.0, loaderFontSize: 1.0, loaderDensity: 1.0, loaderIntensity: 1.0,
    loaderLength: 2.0, loaderBgColor: 'theme', loaderBgAlpha: 0.0,
    loaderLoop: true, loaderWidthMode: 'text', loaderSizeOff: false, loaderMagic: false,
    loaderNoiseRes: 4, loaderTextFade: 0.5, loaderCooling: 0.65, loaderSpread: 0.3,
    splashLength: 1.0, splashFade: 0.3, splashDisabled: false, splashFadeOnChatLoad: false,
    splashCharsetPreset: 'katakana', splashCharsetCustom: '',
    splashQuantity: 1.4, splashMinOpacity: 0.2, splashMaxOpacity: 0.9,
    splashSizeVariance: 0.45, splashColorVariance: 0.32, splashBounce: 1.1,
    splashWordmarkScale: 1.0,
    chatRiseDistance: 260, chatRiseDuration: 0.82, chatRiseTilt: 14, chatRiseBlur: 2,
    chatColorCustom: false,
    loaderColorCustom: false,
    splashColorCustom: false
  };
  window.animConfig = animConfig;
  window.SPLASH_CHARSETS = splashCharsets;

  var ANIM_MODES = ['matrix','zalgo','fire','bounce','spiral','galaxy','leak'];
  window.ANIM_MODES = ANIM_MODES;

  try {
    var savedState = vscode.getState();
    if (savedState) {
      if (savedState.animConfig) Object.assign(animConfig, savedState.animConfig);
      if (savedState._junctionAnimationMode) window._junctionAnimationMode = savedState._junctionAnimationMode;
      if (savedState._junctionAnimColor) window._junctionAnimColor = savedState._junctionAnimColor;
      if (savedState._junctionLoaderAnimColor) window._junctionLoaderAnimColor = savedState._junctionLoaderAnimColor;
      if (savedState._junctionSplashColor) window._junctionSplashColor = savedState._junctionSplashColor;
      if (savedState.bubbleRadius !== undefined) document.documentElement.style.setProperty('--junction-bubble-radius', savedState.bubbleRadius + 'px');
      if (savedState.bubbleTip) document.documentElement.style.setProperty('--junction-bubble-tip', savedState.bubbleTip);
    }
  } catch (e) {}

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function safeNumber(value, fallback) {
    var num = parseFloat(value);
    return isFinite(num) ? num : fallback;
  }

  function uniqueChars(str) {
    var seen = Object.create(null);
    var out = '';
    var i;
    for (i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (seen[ch]) continue;
      seen[ch] = true;
      out += ch;
    }
    return out;
  }

  function parseRgbaColor(raw) {
    if (!raw || typeof raw !== 'string') return { r: 204, g: 204, b: 204, a: 1 };
    var rgbaMatch = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
    if (rgbaMatch) {
      return {
        r: parseInt(rgbaMatch[1], 10),
        g: parseInt(rgbaMatch[2], 10),
        b: parseInt(rgbaMatch[3], 10),
        a: rgbaMatch[4] !== undefined ? safeNumber(rgbaMatch[4], 1) : 1
      };
    }
    if (raw.charAt(0) === '#') {
      var hex = raw.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length === 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: 1
        };
      }
    }
    return { r: 204, g: 204, b: 204, a: 1 };
  }

  function varyColor(base, amount, alpha) {
    var shift = (Math.random() * 2 - 1) * amount;
    var lift = shift > 0 ? (255 * shift) : 0;
    var scale = 1 + Math.min(0, shift);
    var r = clamp(Math.round(base.r * scale + lift), 0, 255);
    var g = clamp(Math.round(base.g * scale + lift), 0, 255);
    var b = clamp(Math.round(base.b * scale + lift), 0, 255);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(alpha, 0, 1) + ')';
  }

  function getSplashCharset() {
    var preset = animConfig.splashCharsetPreset || 'matrix';
    var custom = animConfig.splashCharsetCustom || '';
    var base = splashCharsets[preset] || matrixChars;
    if (preset === 'custom') base = '';
    var combined = uniqueChars(base + custom);
    return combined || matrixChars;
  }

  function applySplashWordmarkScale(scope) {
    var target = scope || document.documentElement;
    if (!target || !target.style) return;
    target.style.setProperty('--junction-splash-wordmark-scale', String(safeNumber(animConfig.splashWordmarkScale, 1)));
  }
  window.applySplashWordmarkScale = applySplashWordmarkScale;
  applySplashWordmarkScale();

  function saveAnimSettings() {
    try {
      var state = vscode.getState() || {};
      state.animConfig = window.animConfig;
      state._junctionAnimationMode = window._junctionAnimationMode;
      state._junctionAnimColor = window._junctionAnimColor;
      state._junctionLoaderAnimColor = window._junctionLoaderAnimColor;
      state._junctionSplashColor = window._junctionSplashColor;
      vscode.setState(state);
      vscode.postMessage({
        type: 'saveAnimConfig',
        config: window.animConfig,
        mode: window._junctionAnimationMode,
        color: window._junctionAnimColor,
        loaderColor: window._junctionLoaderAnimColor,
        splashColor: window._junctionSplashColor
      });
    } catch (e) {}
  }
  window.saveAnimSettings = saveAnimSettings;

  var wackyPositive = '👍';
  var wackyNegative = '👎';
  (function () {
    var positives = ['👍', '😊', 'good', '❤️', '⬆️'];
    var negatives = ['👎', '😠', 'bad', '💔', '⬇️'];
    wackyPositive = positives[Math.floor(Math.random() * positives.length)];
    wackyNegative = negatives[Math.floor(Math.random() * negatives.length)];
  })();

  function getReactionPair() {
    var mode = (window.animConfig && window.animConfig.reactionPair) || 'arrow-caret';
    switch (mode) {
      case 'faces': return { up: '😊', down: '😠' };
      case 'words': return { up: 'good', down: 'bad' };
      case 'hearts': return { up: '❤️', down: '💔' };
      case 'arrows': return { up: '⬆️', down: '⬇️' };
      case 'vector-arrows': return { up: 'codicon:chevron-up', down: 'codicon:chevron-down' };
      case 'arrow-caret': return { up: 'codicon:arrow-up', down: 'codicon:arrow-down' };
      case 'wacky': return { up: wackyPositive, down: wackyNegative };
      default: return { up: '👍', down: '👎' };
    }
  }
  window.getReactionPair = getReactionPair;

  if (!window._junctionSplashColor) window._junctionSplashColor = getComputedStyle(document.body).color;
  if (!window._junctionAnimColor) window._junctionAnimColor = getComputedStyle(document.body).color;

  function getAnimVal(key, fallback, localOpts) {
    if (key === 'widthMode') return 'full';
    var isLoader = window._activeLoaderContext ||
                   (localOpts === true) ||
                   (localOpts && localOpts.loader) ||
                   (localOpts && localOpts.isSplash);
    if (isLoader) {
      var loaderKey = key;
      if (key.indexOf('loader') !== 0) {
        loaderKey = 'loader' + key.charAt(0).toUpperCase() + key.slice(1);
      }
      if (animConfig[loaderKey] !== undefined) return animConfig[loaderKey];
    }
    return animConfig[key] !== undefined ? animConfig[key] : fallback;
  }
  window.getAnimVal = getAnimVal;

  function getAnimSpeed(localOpts) { return getAnimVal('speed', 1.0, localOpts); }
  function getAnimFontSize(localOpts) { return getAnimVal('fontSize', 1.0, localOpts); }
  function getAnimDensity(localOpts) { return getAnimVal('density', 1.0, localOpts); }
  function getAnimIntensity(localOpts) { return getAnimVal('intensity', 1.0, localOpts); }

  function getAnimColor(localOpts) {
    var bodyColor = getComputedStyle(document.body).color;
    if (localOpts && localOpts.isSplash) {
      return animConfig.splashColorCustom ? (window._junctionSplashColor || bodyColor) : bodyColor;
    }
    if (window._activeLoaderContext || (localOpts && localOpts.loader)) {
      return animConfig.loaderColorCustom ? (window._junctionLoaderAnimColor || bodyColor) : bodyColor;
    }
    return animConfig.chatColorCustom ? (window._junctionAnimColor || bodyColor) : bodyColor;
  }
  window.getAnimColor = getAnimColor;

  function getAnimationBgColor(alpha, localOpts) {
    var loader = localOpts && localOpts.isSplash ? document.getElementById('startup-loader') : null;
    var bg = (loader ? getComputedStyle(loader).backgroundColor : '') || getComputedStyle(document.body).backgroundColor;
    if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-sideBar-background').trim() || getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
    var configBg = getAnimVal('bgColor', 'theme', localOpts);
    if (configBg !== 'theme') bg = configBg;
    var a = (alpha !== undefined) ? alpha : getAnimVal('bgAlpha', 0.05, localOpts);
    var m = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/);
    if (m) return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a + ')';
    if (bg.startsWith('#')) {
      var hex = bg.substring(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      var r = parseInt(hex.substring(0,2), 16);
      var g = parseInt(hex.substring(2,4), 16);
      var b = parseInt(hex.substring(4,6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return bg || 'transparent';
  }
  window.getAnimationBgColor = getAnimationBgColor;

  function updateAllCanvasBackgrounds() {
    var canvases = document.querySelectorAll('canvas.pretext-canvas');
    canvases.forEach(function (canvas) {
      if (canvas.classList.contains('textarea-canvas')) return;
      var isLoader = canvas.classList.contains('matrix-loader');
      canvas.style.backgroundColor = getAnimationBgColor(undefined, { loader: isLoader });
    });
  }
  window.updateAllCanvasBackgrounds = updateAllCanvasBackgrounds;

  // ── Fire mode ─────────────────────────────────────────────────────────────
  function createFireCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var tw = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (Math.ceil(maxWidth) + 20)));
    var th = opts.unbounded ? window.innerHeight : (opts.isSplash ? (opts.height || window.innerHeight) : Math.round((lines.length * lineHeight + 20) * (1.0)));

    var noiseRes = getAnimVal('noiseRes', 4, opts);
    var fireW = Math.max(16, Math.ceil(tw / noiseRes));
    var fireH = Math.max(16, Math.ceil(th / noiseRes));
    var heat = new Float32Array(fireW * fireH);
    var color = new Float32Array(fireW * fireH);
    var speed = getAnimSpeed(opts);
    var density = getAnimDensity(opts);
    var intensity = getAnimIntensity(opts);

    function getFirePixel(h, c) {
      var r, g, b;
      var isGreen = false;
      if (isGreen) {
        if (h < 0.25) { r = 0; g = Math.floor(h * 4 * 180); b = 0; }
        else if (h < 0.5) { r = 0; g = 180 + Math.floor((h - 0.25) * 4 * 75); b = Math.floor((h - 0.25) * 4 * 60); }
        else if (h < 0.75) { r = Math.floor((h - 0.5) * 4 * 140); g = 255; b = 60 + Math.floor((h - 0.5) * 4 * 30); }
        else { r = 200 + Math.floor((h - 0.75) * 4 * 55); g = 255; b = 200 + Math.floor((h - 0.75) * 4 * 55); }
      } else {
        if (h < 0.25) { r = Math.floor(h * 4 * 180); g = 0; b = 0; }
        else if (h < 0.5) { r = 180 + Math.floor((h - 0.25) * 4 * 75); g = Math.floor((h - 0.25) * 4 * 60); b = 0; }
        else if (h < 0.75) { r = 255; g = 60 + Math.floor((h - 0.5) * 4 * 140); b = Math.floor((h - 0.5) * 4 * 30); }
        else { r = 255; g = 200 + Math.floor((h - 0.75) * 4 * 55); b = 30 + Math.floor((h - 0.75) * 4 * 100); }
      }
      var flicker = 0.85 + c * 0.3;
      return { r: Math.min(255, Math.floor(r * flicker)), g: Math.min(255, Math.floor(g * flicker)), b: Math.min(255, Math.floor(b * flicker)) };
    }

    function seedText() {
      if (opts.isSplash || opts.loader) {
        var seedY = opts.isSplash ? Math.floor(fireH / 2) : (fireH - 1);
        for (var x = 0; x < fireW; x++) { heat[(seedY * fireW) + x] = 0.85 + Math.random() * 0.15; color[(seedY * fireW) + x] = Math.random(); }
        return;
      }
      ctx.font = fontStr;
      lines.forEach(function (line, i) {
        var y = Math.floor(((opts.unbounded && opts.rect ? opts.rect.top : 0) + (i + 1) * lineHeight) / noiseRes);
        if (y >= fireH) return;
        var startX = (opts.unbounded && opts.rect) ? Math.floor(opts.rect.left / noiseRes) : 0;
        var endX = (opts.unbounded && opts.rect) ? Math.floor(opts.rect.right / noiseRes) : fireW;
        for (var x = startX; x < endX; x++) {
          var px = (x - startX) * noiseRes;
          var charAtX = Math.floor(px / fontSize);
          if (charAtX < line.length && line.charAt(charAtX) !== ' ') {
            if (x >= 0 && x < fireW) { heat[(y * fireW) + x] = 0.8 + Math.random() * 0.2; color[(y * fireW) + x] = Math.random(); }
          }
        }
      });
    }

    var cooling = getAnimVal('cooling', 0.65, opts);
    var spreadRate = getAnimVal('spread', 0.3, opts);

    function propagateFire() {
      for (var y = 1; y < fireH; y++) {
        for (var x = 0; x < fireW; x++) {
          var idx = y * fireW + x;
          var below = ((y - 1) * fireW) + x;
          var spread = 0;
          if (x > 0) spread += heat[below - 1] * spreadRate;
          spread += heat[below] * (1 - spreadRate * 2);
          if (x < fireW - 1) spread += heat[below + 1] * spreadRate;
          var noise2 = (Math.random() - 0.5) * 0.15 * intensity;
          heat[idx] = Math.max(0, Math.min(1, spread * cooling + noise2));
          color[idx] = (color[idx] * 0.9 + Math.random() * 0.1 * intensity);
        }
      }
      var seedY = opts.isSplash ? Math.floor(fireH / 2) : (fireH - 1);
      var startX = 0;
      var endX = fireW;
      if (opts.unbounded && opts.rect && !opts.magic && !opts.loaderMagic) {
        seedY = Math.floor((opts.rect.top + opts.rect.height) / noiseRes);
        startX = Math.floor(opts.rect.left / noiseRes);
        endX = Math.floor(opts.rect.right / noiseRes);
      }
      if (seedY >= 0 && seedY < fireH) {
        for (var x = startX; x < endX; x++) {
          if (x >= 0 && x < fireW) { if (Math.random() < density * 0.3) heat[seedY * fireW + x] = 0.6 + Math.random() * 0.4; }
        }
      }
    }

    canvas.width = tw;
    canvas.height = th;
    canvas.style.width = tw + 'px';
    canvas.style.height = th + 'px';

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 2000;
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
            for (var dy = 0; dy < noiseRes && (fy * noiseRes + dy) < th; dy++) {
              for (var dx = 0; dx < noiseRes && (fx * noiseRes + dx) < tw; dx++) {
                var pi = ((fy * noiseRes + dy) * tw + (fx * noiseRes + dx)) * 4;
                pixels[pi] = rgb.r; pixels[pi + 1] = rgb.g; pixels[pi + 2] = rgb.b; pixels[pi + 3] = 255;
              }
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);
        if (!opts.isSplash && !opts.unbounded) {
          ctx.font = fontStr;
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = getAnimColor(opts);
          lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); });
          ctx.globalAlpha = 1;
        }
        animId = requestAnimationFrame(frame);
        return;
      }

      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);
      propagateFire();
      var imgData = ctx.createImageData(tw, th);
      var pixels = imgData.data;
      for (var fy = 0; fy < fireH; fy++) {
        for (var fx = 0; fx < fireW; fx++) {
          var h = heat[fy * fireW + fx];
          var c = color[fy * fireW + fx];
          if (h < 0.02) continue;
          var rgb = getFirePixel(h, c);
          for (var dy = 0; dy < noiseRes && (fy * noiseRes + dy) < th; dy++) {
            for (var dx = 0; dx < noiseRes && (fx * noiseRes + dx) < tw; dx++) {
              var pi = ((fy * noiseRes + dy) * tw + (fx * noiseRes + dx)) * 4;
              pixels[pi] = rgb.r; pixels[pi + 1] = rgb.g; pixels[pi + 2] = rgb.b; pixels[pi + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);

      var textFade = getAnimVal('textFade', 0.0, opts);
      var textAlpha;
      if (textFade > 0) { textAlpha = Math.max(0, 1 - (progress * textFade)); }
      else { textAlpha = (progress > 0.3) ? Math.min(1, (progress - 0.3) / 0.5) : 0; }

      if (!opts.isSplash && !opts.unbounded && textAlpha > 0) {
        ctx.font = fontStr;
        ctx.globalAlpha = textAlpha;
        ctx.fillStyle = getAnimColor(opts);
        lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); });
        ctx.globalAlpha = 1;
      }

      if (progress < 1) {
        animId = requestAnimationFrame(frame);
      } else {
        if (opts.loop || getAnimVal('loop', false, opts)) {
          startTime = performance.now(); heat.fill(0); color.fill(0); seedText();
          animId = requestAnimationFrame(frame);
        } else {
          done = true; ctx.clearRect(0, 0, tw, th);
          if (!opts.isSplash && !opts.unbounded) {
            ctx.font = fontStr;
            ctx.fillStyle = getComputedStyle(document.body).color;
            lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); });
          }
        }
      }
    }
    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
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
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var tw = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (Math.ceil(maxWidth) + 20)));
    var th = opts.unbounded ? window.innerHeight : (opts.isSplash ? (opts.height || window.innerHeight) : (lines.length * lineHeight + 20));
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var chars = [];
    if (opts.isSplash) {
      var charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=-';
      for (var i = 0; i < 60; i++) {
        var ch = charset.charAt(Math.floor(Math.random() * charset.length));
        var targetX = Math.random() * tw;
        var targetY = Math.random() * th;
        var angle = Math.random() * Math.PI * 2;
        var dist = 200 + Math.random() * 300;
        chars.push({ ch: ch, targetX: targetX, targetY: targetY, x: targetX + Math.cos(angle) * dist, y: targetY + Math.sin(angle) * dist, rotation: (Math.random() - 0.5) * 12, targetRotation: 0, bouncePhase: Math.random() * Math.PI * 2, delay: Math.random() * (600 / getAnimSpeed(opts)), settled: false });
      }
    } else {
      var charIndex = 0;
      for (var r = 0; r < lines.length; r++) {
        var line = lines[r];
        var currentXOffset = (opts.unbounded && opts.rect) ? opts.rect.left : 10;
        for (var c = 0; c < line.length; c++) {
          var ch = line.charAt(c);
          var chWidth = ctx.measureText(ch).width || (fontSize * 0.6);
          var targetX = currentXOffset;
          currentXOffset += chWidth;
          if (ch === ' ') continue;
          var targetY = ((opts.unbounded && opts.rect) ? opts.rect.top : 0) + (r + 1) * lineHeight;
          var angle = Math.random() * Math.PI * 2;
          var dist = 200 + Math.random() * 300;
          chars.push({ ch: ch, targetX: targetX, targetY: targetY, x: targetX + Math.cos(angle) * dist, y: targetY + Math.sin(angle) * dist, rotation: (Math.random() - 0.5) * 12, targetRotation: 0, bouncePhase: opts.loader ? (charIndex * 0.4) : (Math.random() * Math.PI * 2), delay: charIndex * (30 / getAnimSpeed(opts)), settled: false });
          charIndex++;
        }
      }
    }

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 2500;
    var done = false;
    var animId = null;

    function frame() {
      if (done) return;
      if (opts.loader) {
        ctx.clearRect(0, 0, tw, th);
        ctx.font = fontStr;
        var fgColor = getAnimColor(opts);
        chars.forEach(function (c) {
          var yOffset = Math.sin(performance.now() * 0.005 * getAnimSpeed(opts) + c.bouncePhase) * (lineHeight * 0.3 * getAnimIntensity(opts));
          ctx.save(); ctx.translate(c.targetX, c.targetY + yOffset); ctx.globalAlpha = 1; ctx.fillStyle = fgColor; ctx.fillText(c.ch, 0, 0); ctx.restore();
        });
        animId = requestAnimationFrame(frame);
        return;
      }
      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;
      var fgColor = getComputedStyle(document.body).color;
      chars.forEach(function (c) {
        var t = Math.max(0, Math.min(1, (elapsed - c.delay) / 800));
        if (t <= 0) return;
        var ease = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 2 + c.bouncePhase) * (t < 0.9 ? 1 : 0);
        ease = Math.max(0, Math.min(1, ease));
        var curX = c.x + (c.targetX - c.x) * ease;
        var curY = c.y + (c.targetY - c.y) * ease;
        var curRot = c.rotation * (1 - ease);
        ctx.save(); ctx.translate(curX, curY); ctx.rotate(curRot); ctx.globalAlpha = ease; ctx.fillStyle = fgColor; ctx.fillText(c.ch, 0, 0); ctx.restore();
      });
      ctx.globalAlpha = 1;
      if (progress < 1) { animId = requestAnimationFrame(frame); }
      else {
        if (opts.loop || getAnimVal('loop', false, opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
        else { done = true; ctx.clearRect(0, 0, tw, th); if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = fgColor; lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); }); } }
      }
    }
    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
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
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
    var lineHeight = Math.round(fontSize * 1.5);
    ctx.font = fontStr;

    var lines = text ? text.split('\n') : [''];
    var maxWidth = 0;
    lines.forEach(function (l) { maxWidth = Math.max(maxWidth, ctx.measureText(l).width); });
    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var tw = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (Math.ceil(maxWidth) + 20)));
    var th = opts.unbounded ? window.innerHeight : (opts.isSplash ? (opts.height || window.innerHeight) : (lines.length * lineHeight + 20));
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var centerX = opts.unbounded && opts.rect ? (opts.rect.left + opts.rect.width / 2) : (tw / 2);
    var centerY = opts.unbounded && opts.rect ? (opts.rect.top + opts.rect.height / 2) : (th / 2);
    var fgColor = getComputedStyle(document.body).color;
    var isGalaxy = (window._junctionAnimationMode === 'galaxy');

    var chars = [];
    if (opts.isSplash) {
      var charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=-';
      for (var i = 0; i < 100; i++) {
        var ch = charset.charAt(Math.floor(Math.random() * charset.length));
        var angle = Math.random() * Math.PI * 2;
        var maxRadius = Math.sqrt(tw*tw + th*th) / 2;
        var dist = Math.random() * maxRadius;
        var targetX = centerX + Math.cos(angle) * dist;
        var targetY = centerY + Math.sin(angle) * dist;
        chars.push({ ch: ch, targetX: targetX, targetY: targetY, startAngle: angle + (Math.random() - 0.5) * 0.5, startDist: dist + 200 + Math.random() * 300, rowDelay: Math.random() * (400 / getAnimSpeed(opts)), hue: Math.floor(Math.random() * 360) });
      }
    } else {
      for (var r = 0; r < lines.length; r++) {
        var line = lines[r];
        var lineLen = line.length;
        var midCol = (lineLen - 1) / 2;
        var currentXOffset = (opts.unbounded && opts.rect) ? opts.rect.left : 10;
        for (var c = 0; c < lineLen; c++) {
          var ch = line.charAt(c);
          var chWidth = ctx.measureText(ch).width || (fontSize * 0.6);
          var targetX = currentXOffset;
          currentXOffset += chWidth;
          if (ch === ' ') continue;
          var targetY = ((opts.unbounded && opts.rect) ? opts.rect.top : 0) + (r + 1) * lineHeight;
          chars.push({ ch: ch, targetX: targetX, targetY: targetY, startAngle: c * 0.5 + r * 1.5 + Math.random() * 0.2, startDist: 120 + Math.random() * 100, rowDelay: Math.abs(c - midCol) * (120 / getAnimSpeed(opts)), hue: (c * 20 + r * 40) % 360 });
        }
      }
    }

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 2200;
    var done = false;
    var animId = null;

    function frame() {
      if (done) return;
      if (opts.loader) {
        ctx.clearRect(0, 0, tw, th);
        ctx.font = fontStr;
        var orbitAngle = performance.now() * 0.003;
        chars.forEach(function (c) {
          var curX = c.targetX + Math.cos(orbitAngle) * 8 * getAnimIntensity(opts);
          var curY = c.targetY + Math.sin(orbitAngle) * 8 * getAnimIntensity(opts);
          ctx.save(); ctx.translate(curX, curY); ctx.globalAlpha = 1; ctx.fillStyle = getAnimColor(opts); ctx.fillText(c.ch, 0, 0); ctx.restore();
        });
        animId = requestAnimationFrame(frame);
        return;
      }
      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;
      chars.forEach(function (c) {
        var t = isGalaxy ? Math.max(0, Math.min(1, elapsed / (duration * 0.85))) : Math.max(0, Math.min(1, (elapsed - c.rowDelay) / (duration * 0.6)));
        if (t <= 0) return;
        var spiralProgress = t * t * t;
        var curAngle = c.startAngle + spiralProgress * 8;
        var curDist = c.startDist * (1 - spiralProgress);
        var curX, curY;
        if (isGalaxy) {
          curX = (centerX + Math.cos(curAngle) * curDist) * (1 - spiralProgress) + c.targetX * spiralProgress;
          curY = (centerY + Math.sin(curAngle) * curDist) * (1 - spiralProgress) + c.targetY * spiralProgress;
        } else {
          curX = c.targetX + Math.cos(curAngle) * curDist;
          curY = c.targetY + Math.sin(curAngle) * curDist;
        }
        ctx.save(); ctx.translate(curX, curY); ctx.scale(0.5 + spiralProgress * 0.5, 0.5 + spiralProgress * 0.5); ctx.globalAlpha = Math.min(1, t * 2);
        ctx.fillStyle = getAnimColor(opts); ctx.fillText(c.ch, 0, 0); ctx.restore();
      });
      ctx.globalAlpha = 1;
      if (progress < 1) { animId = requestAnimationFrame(frame); }
      else {
        if (opts.loop || getAnimVal('loop', false, opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
        else { done = true; ctx.clearRect(0, 0, tw, th); if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = fgColor; lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); }); } }
      }
    }
    requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }

  // ── Matrix mode ─────────────────────────────────────────────────────────
  function createMatrixCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
    var lineHeight = Math.round(fontSize * 1.5);

    var prepared = null;
    var lines = [];
    if (PretextAPI && PretextAPI.prepareWithSegments && PretextAPI.layoutWithLines) {
      try {
        var containerWidth = (opts.width || 600);
        prepared = PretextAPI.prepareWithSegments(text, fontStr);
        var layoutResult = PretextAPI.layoutWithLines(prepared, containerWidth, lineHeight);
        lines = (layoutResult.lines || []).map(function (l) { return l.text || l; });
      } catch (e) { lines = text.split('\n'); }
    } else { lines = text.split('\n'); }
    if (lines.length === 0) lines = [''];

    ctx.font = fontStr;
    var maxWidth = 0;
    lines.forEach(function (line) { maxWidth = Math.max(maxWidth, ctx.measureText(line).width); });
    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var tw = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (Math.ceil(maxWidth) + 20)));
    var th = opts.unbounded ? window.innerHeight : (opts.isSplash ? (opts.height || window.innerHeight) : (lines.length * lineHeight + 20));
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var charWidth = fontSize * 0.6;
    var startX = 0;
    var cols = Math.ceil(tw / charWidth);
    if (opts.unbounded && opts.rect && !opts.magic && !opts.loaderMagic) { startX = opts.rect.left; cols = Math.ceil(opts.rect.width / charWidth); }
    var colStates = [];
    for (var c = 0; c < cols; c++) {
      var startY = (opts.isSplash ? Math.floor(th / 2) : th);
      if (opts.unbounded && opts.rect && !opts.magic && !opts.loaderMagic) startY = opts.rect.bottom;
      colStates.push({ phase: 'rain', y: startY + Math.random() * 60, speed: (1.2 + Math.random() * 2.5) * getAnimSpeed(opts), char: matrixChars[Math.floor(Math.random() * matrixChars.length)], opacity: 0.2 + Math.random() * 0.6 });
    }

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 1200;
    var done = false;
    var animId = null;
    var fgColor = getComputedStyle(document.body).color;

    function frame(now) {
      if (done) return;
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, tw, th);
      ctx.font = fontStr;
      if (!opts.isSplash && !opts.unbounded) {
        lines.forEach(function (line, i) {
          var settleProgress = Math.max(0, Math.min(1, (progress - 0.2 - i * 0.04) / 0.35));
          if (settleProgress > 0) { ctx.globalAlpha = settleProgress; ctx.fillStyle = fgColor; ctx.fillText(line, 10, (i + 1) * lineHeight); }
        });
      }
      ctx.globalAlpha = 1;
      colStates.forEach(function (col, ci) {
        if (col.phase === 'done') return;
        if (col.phase === 'rain') {
          col.y -= col.speed * 2;
          if (col.y < -20) { col.phase = 'done'; return; }
          ctx.globalAlpha = col.opacity * Math.max(0, 1 - progress);
          ctx.fillStyle = getAnimColor(opts);
          ctx.fillText(col.char, startX + ci * charWidth, col.y);
        }
      });
      ctx.globalAlpha = 1;
      if (progress < 1) { animId = requestAnimationFrame(frame); }
      else {
        if (opts.loop || getAnimVal('loop', false, opts)) {
          startTime = performance.now();
          colStates.forEach(function (col) {
            col.phase = 'rain';
            col.y = (opts.isSplash ? Math.floor(th / 2) : th) + Math.random() * 60;
          });
          animId = requestAnimationFrame(frame);
        } else {
          done = true; ctx.clearRect(0, 0, tw, th);
          if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = fgColor; lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); }); }
        }
      }
    }
    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }

  // ── Zalgo mode ────────────────────────────────────────────────────────────
  var ZALGO_UP_a = ['\u0300','\u0301','\u0302','\u0303','\u0304','\u0305','\u0306','\u0307','\u0308','\u0309','\u030A','\u030B','\u030C','\u030D','\u030E','\u030F','\u0310','\u0311','\u0312','\u0313','\u0314','\u0315','\u031A','\u031B','\u033D','\u033E','\u033F','\u0340','\u0341','\u0342','\u0343','\u0344','\u0346','\u034A','\u034B','\u034C','\u034F','\u0350','\u0351','\u0352','\u0357','\u0358','\u035C','\u035D','\u035E','\u0360','\u0361'];
  var ZALGO_CHARS_a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!';

  function createZalgoCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
    var lineHeight = Math.round(fontSize * 1.5);

    var baselineText = text || '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
    var baselineWidth = 300;
    if (PretextAPI && PretextAPI.prepareWithSegments && PretextAPI.measureNaturalWidth) {
      try {
        var prepared = PretextAPI.prepareWithSegments(baselineText, fontStr);
        baselineWidth = PretextAPI.measureNaturalWidth(prepared);
      } catch (e) {}
    } else { ctx.font = fontStr; baselineWidth = ctx.measureText(baselineText).width; }

    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var canvasWidth = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (baselineWidth + 20)));
    var charWidth = fontSize * 0.55;
    var startX = 10;
    var numCols = Math.max(4, Math.floor((canvasWidth / charWidth) * getAnimDensity(opts)));
    if (opts.unbounded && opts.rect && !opts.magic && !opts.loaderMagic) { startX = opts.rect.left; numCols = Math.max(4, Math.floor((opts.rect.width / charWidth) * getAnimDensity(opts))); }
    var riseHeight = fontSize * 4 * getAnimIntensity(opts);
    var canvasHeight = opts.unbounded ? window.innerHeight : (opts.height || (opts.isSplash ? window.innerHeight : (riseHeight + lineHeight + 10)));
    canvas.width = Math.ceil(canvasWidth); canvas.height = Math.ceil(canvasHeight);
    canvas.style.width = canvas.width + 'px'; canvas.style.height = canvas.height + 'px';

    var baselineY = (opts.unbounded && opts.rect && !opts.magic && !opts.loaderMagic) ? opts.rect.bottom : (opts.isSplash ? Math.floor(canvasHeight / 2) : (canvasHeight - lineHeight));

    var columns = [];
    function initColumns() {
      columns = [];
      for (var c = 0; c < numCols; c++) {
        columns.push({ x: c * charWidth + startX, baseChar: ZALGO_CHARS_a[Math.floor(Math.random() * ZALGO_CHARS_a.length)], accentSeed: Math.floor(Math.random() * 100), opacity: 0.3 + Math.random() * 0.7, speed: 0.8 + Math.random() * 1.5, settled: false, y: opts.loader ? (10 + Math.random() * (baselineY - 10)) : baselineY });
      }
    }
    initColumns();

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 1500;
    var done = false;
    var animId = null;

    function frame(now) {
      if (done) return;
      if (opts.loader) {
        ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.font = fontStr;
        if (!opts.isSplash && !opts.unbounded) { ctx.globalAlpha = 0.6; ctx.fillStyle = getAnimColor(opts); ctx.fillText(baselineText, 10, baselineY); }
        columns.forEach(function (col) {
          col.y -= col.speed * 0.5 * getAnimSpeed(opts);
          if (col.y < 10) { col.y = baselineY; col.baseChar = ZALGO_CHARS_a[Math.floor(Math.random() * ZALGO_CHARS_a.length)]; col.accentSeed = Math.floor(Math.random() * 100); }
          var timeFactor = performance.now() * 0.008 * getAnimSpeed(opts) * col.speed;
          var rawCount = 3 + Math.sin(timeFactor + col.x * 0.05) * 4;
          var numAccents = Math.max(1, Math.min(8, Math.round(rawCount)));
          var marks = '';
          for (var i = 0; i < numAccents; i++) marks += ZALGO_UP_a[(col.accentSeed + i) % ZALGO_UP_a.length];
          ctx.globalAlpha = col.opacity; ctx.fillStyle = getAnimColor(opts);
          ctx.fillText(col.baseChar + marks, col.x + Math.sin(performance.now() * 0.01 + col.x) * 2, col.y);
        });
        ctx.globalAlpha = 1; animId = requestAnimationFrame(frame); return;
      }

      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.font = fontStr;
      if (!opts.isSplash && !opts.unbounded) { ctx.globalAlpha = 0.6; ctx.fillStyle = getAnimColor(opts); ctx.fillText(baselineText, 10, baselineY); }
      columns.forEach(function (col) {
        if (col.settled) return;
        var colProgress = progress;
        var rise = colProgress * riseHeight;
        var y = baselineY - rise;

        var timeFactor = elapsed * 0.008 * getAnimSpeed(opts) * col.speed;
        var rawCount = 3 + Math.sin(timeFactor + col.x * 0.05) * 4;
        var numAccents = Math.max(1, Math.min(8, Math.round(rawCount)));
        var marks = '';
        for (var i = 0; i < numAccents; i++) marks += ZALGO_UP_a[(col.accentSeed + i) % ZALGO_UP_a.length];
        ctx.globalAlpha = col.opacity * (1 - progress * 0.3); ctx.fillStyle = getAnimColor(opts);
        ctx.fillText(col.baseChar + marks, col.x + Math.sin(elapsed * 0.01 + col.x) * 2, y);
        if (progress >= 0.95) col.settled = true;
      });
      ctx.globalAlpha = 1;
      if (progress < 1) { animId = requestAnimationFrame(frame); }
      else {
        if (opts.loop || getAnimVal('loop', false, opts)) { startTime = performance.now(); initColumns(); animId = requestAnimationFrame(frame); }
        else { done = true; ctx.clearRect(0, 0, canvas.width, canvas.height); if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = getAnimColor(opts); ctx.globalAlpha = 0.5; ctx.fillText(baselineText, 10, baselineY); ctx.globalAlpha = 1; } }
      }
    }
    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }

  // ── Leak mode ────────────────────────────────────────────────────────────
  function createLeakCanvas(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontStr = getCurrentFont();
    var fontSize = Math.round((parseInt(getComputedStyle(document.body).fontSize) || 13) * getAnimFontSize(opts));
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
    } else { lines = text.split('\n'); }
    if (lines.length === 0) lines = [''];

    ctx.font = fontStr;
    var maxWidth = 0;
    lines.forEach(function (line) { maxWidth = Math.max(maxWidth, ctx.measureText(line).width); });
    var isFull = (getAnimVal('widthMode', 'text', opts) === 'full');
    var tw = opts.unbounded ? window.innerWidth : ((opts.isSplash || opts.loader) ? (opts.width || window.innerWidth) : (isFull ? (opts.width || 600) : (Math.ceil(maxWidth) + 20)));
    var th = opts.unbounded ? window.innerHeight : (opts.isSplash ? (opts.height || window.innerHeight) : (lines.length * lineHeight + 25));
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';

    var startTime = performance.now();
    var duration = opts.duration || (getAnimVal('length', 2.0, opts) * 1000) || 1200;
    var done = false;
    var animId = null;
    var fgColor = getComputedStyle(document.body).color;
    var animColor = getAnimColor(opts);
    var thresholdY = opts.unbounded && opts.rect ? opts.rect.bottom : (opts.isSplash ? Math.floor(th / 2) : (th - 12));

    function frame(now) {
      if (done) return;
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      ctx.clearRect(0, 0, tw, th); ctx.font = fontStr;
      if (!opts.isSplash && !opts.unbounded) {
        lines.forEach(function (line, i) {
          var lineProgress = Math.max(0, Math.min(1, (progress - i * 0.1) / 0.5));
          if (lineProgress > 0) {
            ctx.globalAlpha = lineProgress; ctx.fillStyle = fgColor;
            var finalY = (i + 1) * lineHeight;
            var startY = thresholdY;
            var currentY = startY - (startY - finalY) * lineProgress;
            var jitter = 0;
            if (lineProgress < 0.4) jitter = (Math.random() - 0.5) * 4 * (1 - lineProgress / 0.4);
            ctx.fillText(line, 10 + jitter, currentY);
          }
        });
      }
      ctx.globalAlpha = Math.max(0, 1 - progress);
      if (ctx.globalAlpha > 0) {
        ctx.fillStyle = animColor;
        var startX = 10, endX = tw - 10;
        if (opts.unbounded && opts.rect) { startX = opts.rect.left; endX = opts.rect.right; }
        for (var x = startX; x < endX; x += 8) {
          if (Math.random() > 0.4) ctx.fillRect(x, thresholdY - (2 + Math.random() * 6) / 2, 4, 2 + Math.random() * 6);
        }
      }
      ctx.globalAlpha = 1;
      if (progress < 1) { animId = requestAnimationFrame(frame); }
      else {
        if (opts.loop || getAnimVal('loop', false, opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
        else { done = true; ctx.clearRect(0, 0, tw, th); if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = fgColor; lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); }); } }
      }
    }
    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }

  // ── Matrix loader (boot/working states) ──────────────────────────────────
  function buildSplashWordmarkMask(canvas, text) {
    if (!canvas) return null;
    var wordmarkText = text || 'Junction';
    var bodyStyle = getComputedStyle(document.body);
    var scale = safeNumber(animConfig.splashWordmarkScale, 1);
    var fontSize = Math.round(Math.max(24, Math.min(96, canvas.width * 0.12, canvas.height * 0.2)) * scale);
    var font = '600 ' + fontSize + 'px ' + (bodyStyle.fontFamily || 'sans-serif');
    var measureCanvas = document.createElement('canvas');
    var measureCtx = measureCanvas.getContext('2d');
    if (!measureCtx) return null;
    measureCtx.font = font;
    var measured = measureCtx.measureText(wordmarkText);
    var width = Math.max(1, Math.ceil(measured.width + fontSize * 0.35));
    var height = Math.max(1, Math.ceil(fontSize * 1.25));
    var left = Math.max(0, Math.floor((canvas.width - width) / 2));
    var top = Math.max(0, Math.floor((canvas.height - height) / 2));
    var offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    var offCtx = offscreen.getContext('2d');
    if (!offCtx) return null;
    offCtx.clearRect(0, 0, width, height);
    offCtx.fillStyle = getComputedStyle(document.body).color;
    offCtx.textAlign = 'center';
    offCtx.textBaseline = 'middle';
    offCtx.font = font;
    offCtx.fillText(wordmarkText, width / 2, height / 2);
    var data = offCtx.getImageData(0, 0, width, height).data;
    return {
      left: left,
      top: top,
      width: width,
      height: height,
      right: left + width,
      bottom: top + height,
      centerX: left + width / 2,
      text: wordmarkText,
      font: font,
      textX: canvas.width / 2,
      textY: canvas.height / 2,
      hit: function (x, y) {
        var lx = Math.floor(x - left);
        var ly = Math.floor(y - top);
        if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
        return data[(ly * width + lx) * 4 + 3] > 24;
      }
    };
  }

  function drawSplashWordmark(ctx, mask, opts) {
    if (!ctx || !mask) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = mask.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = getAnimColor(opts);
    ctx.fillText(mask.text, mask.textX, mask.textY);
    ctx.restore();
  }

  function createMatrixLoader(width, height, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'pretext-canvas matrix-loader';
    var tw = opts.unbounded ? window.innerWidth : (width || 200);
    var th = opts.unbounded ? window.innerHeight : (height || 40);
    canvas.width = tw; canvas.height = th;
    canvas.style.width = tw + 'px'; canvas.style.height = th + 'px';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var fontSize = Math.round(11 * getAnimFontSize(opts));
    ctx.font = fontSize + 'px monospace';
    var splashQuantity = opts.isSplash ? clamp(safeNumber(animConfig.splashQuantity, 1.4), 0.3, 4) : 1;
    var cols = Math.max(2, Math.floor((canvas.width / fontSize) * getAnimDensity(opts) * splashQuantity));
    var wordmarkMask = opts.isSplash ? buildSplashWordmarkMask(canvas, opts.text || 'Junction') : null;
    var splashCharset = opts.isSplash ? getSplashCharset() : matrixChars;
    var splashEffect = opts.splashEffect || 'matrix';
    var splashMinOpacity = clamp(safeNumber(animConfig.splashMinOpacity, 0.2), 0.02, 1);
    var splashMaxOpacity = clamp(safeNumber(animConfig.splashMaxOpacity, 0.9), splashMinOpacity, 1);
    var splashSizeVariance = clamp(safeNumber(animConfig.splashSizeVariance, 0.45), 0, 1.4);
    var splashColorVariance = clamp(safeNumber(animConfig.splashColorVariance, 0.32), 0, 1);
    var splashBounce = clamp(safeNumber(animConfig.splashBounce, 1.1), 0, 3);
    var splashColorBase = parseRgbaColor(getAnimColor(opts));
    var drops = [];
    var i;

    function randomSplashChar() {
      var ch = splashCharset.charAt(Math.floor(Math.random() * splashCharset.length));
      if (splashEffect === 'zalgo') {
        var count = 1 + Math.floor(Math.random() * 3);
        for (var i = 0; i < count; i++) ch += ZALGO_SPLASH_MARKS[Math.floor(Math.random() * ZALGO_SPLASH_MARKS.length)];
      }
      return ch;
    }

    function assignSplashStyle(drop) {
      drop.scale = 1 + ((Math.random() * 2 - 1) * splashSizeVariance);
      drop.scale = clamp(drop.scale, 0.45, 2.4);
      drop.behind = Math.random() < 0.34;
      drop.alpha = splashMinOpacity + Math.random() * (splashMaxOpacity - splashMinOpacity);
      if (drop.behind) drop.alpha *= 0.66;
      drop.fill = varyColor(splashColorBase, splashColorVariance, drop.alpha);
    }

    for (i = 0; i < cols; i++) {
      var laneX = (i + 0.5) * (canvas.width / cols);
      var drop = {
        x: laneX,
        laneX: laneX,
        y: canvas.height + Math.random() * canvas.height * 0.3,
        vy: -(0.8 + Math.random() * 1.6) * getAnimIntensity(opts),
        vx: (Math.random() - 0.5) * 0.04,
        speed: (0.5 + Math.random() * 1.5) * getAnimIntensity(opts),
        ch: opts.isSplash ? randomSplashChar() : matrixChars[Math.floor(Math.random() * matrixChars.length)],
        alpha: opts.isSplash ? 1 : (0.5 + Math.random() * 0.5),
        behind: false,
        scale: 1,
        fill: getAnimColor(opts)
      };
      if (opts.isSplash) assignSplashStyle(drop);
      drops.push(drop);
    }

    function resetSplashDrop(drop) {
      drop.x = drop.laneX + (Math.random() - 0.5) * fontSize * 0.12;
      drop.y = canvas.height + Math.random() * canvas.height * 0.25;
      drop.vx = (Math.random() - 0.5) * 0.04;
      drop.vy = -(0.8 + Math.random() * 1.4);
      drop.ch = randomSplashChar();
      assignSplashStyle(drop);
    }

    function drawSplashLoader() {
      if (canvas.closest && canvas.closest('#startup-loader.dismissed')) return;
      wordmarkMask = buildSplashWordmarkMask(canvas, opts.text || 'Junction') || wordmarkMask;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = getAnimationBgColor(0.08, opts);
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      drops.forEach(function (drop) {
        drop.ch = Math.random() < 0.16 ? randomSplashChar() : drop.ch;
        drop.vy -= 0.015 * getAnimSpeed(opts);
        drop.vx *= 0.88;
        drop.vx += (drop.laneX - drop.x) * 0.0025;
        var nextX = drop.x + drop.vx * fontSize;
        var nextY = drop.y + drop.vy * fontSize * 0.36 * getAnimSpeed(opts);
        if (!drop.behind && wordmarkMask && wordmarkMask.hit(nextX, nextY)) {
          var side = nextX < wordmarkMask.centerX ? -1 : 1;
          if (drop.y < wordmarkMask.top + wordmarkMask.height * 0.4) {
            nextY = wordmarkMask.top - 1;
            drop.vy *= -(0.12 + splashBounce * 0.16);
            drop.vx += side * (0.05 + splashBounce * (0.08 + Math.random() * 0.1));
          } else {
            drop.vx += side * (0.03 + splashBounce * (0.04 + Math.random() * 0.06));
            nextX += side * fontSize * (0.03 + splashBounce * (0.03 + Math.random() * 0.04));
            nextY = drop.y + Math.max(0.3, drop.vy * (0.14 + splashBounce * 0.04));
          }
        }
        drop.x = nextX;
        drop.y = nextY;
        if (drop.x < -fontSize || drop.x > canvas.width + fontSize || drop.y > canvas.height + fontSize) {
          resetSplashDrop(drop);
        }
      });

      [true].forEach(function (behindLayer) {
        drops.forEach(function (drop) {
          if (drop.behind !== behindLayer) return;
          ctx.globalAlpha = 1;
          ctx.fillStyle = drop.fill;
          ctx.font = Math.max(7, Math.round(fontSize * drop.scale)) + 'px monospace';
          ctx.fillText(drop.ch, drop.x, drop.y);
        });
      });
      drawSplashWordmark(ctx, wordmarkMask, opts);
      [false].forEach(function (behindLayer) {
        drops.forEach(function (drop) {
          if (drop.behind !== behindLayer) return;
          ctx.globalAlpha = 1;
          ctx.fillStyle = drop.fill;
          ctx.font = Math.max(7, Math.round(fontSize * drop.scale)) + 'px monospace';
          ctx.fillText(drop.ch, drop.x, drop.y);
        });
      });
      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(drawSplashLoader);
    }

    var animId = null;
    function draw() {
      if (canvas.closest && canvas.closest('#startup-loader.dismissed')) return;
      if (opts.isSplash) {
        drawSplashLoader();
        return;
      }
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = getAnimationBgColor(0.08, opts);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = getAnimColor(opts);
      ctx.font = fontSize + 'px monospace';
      drops.forEach(function (drop, i) {
        var ch = matrixChars[Math.floor(Math.random() * matrixChars.length)];
        ctx.globalAlpha = 0.5 + Math.random() * 0.5;
        ctx.fillText(ch, i * fontSize, drop.y);
        drop.y += drop.speed * fontSize * 0.5 * getAnimSpeed(opts);
        if (drop.y > canvas.height && Math.random() > 0.975) drop.y = 0;
      });
      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(draw);
    }
    draw();
    canvas._stopAnimation = function () { if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }
  window.createMatrixLoader = createMatrixLoader;

  // ── Dispatcher ────────────────────────────────────────────────────────────
  function createAnimatedCanvas(text, opts) {
    opts = opts || {};
    var mode = opts.mode || window._junctionAnimationMode || 'matrix';
    if (opts.loader) {
      var loaderMode = getAnimVal('loaderMode', 'default', opts);
      if (loaderMode !== 'default') mode = loaderMode;
    }
    if (opts.loader) window._activeLoaderContext = true;
    var canvas = null;
    try {
      if (opts.loader && opts.isSplash && (mode === 'matrix' || mode === 'zalgo')) {
        canvas = createMatrixLoader(opts.width, opts.height || 40, Object.assign({}, opts, { splashEffect: mode, text: text || 'Junction' }));
      }
      else if (opts.loader && mode === 'matrix') { canvas = createMatrixLoader(opts.width, opts.height || 40, opts); }
      else {
        switch (mode) {
          case 'zalgo': canvas = createZalgoCanvas(text, opts); break;
          case 'fire': canvas = createFireCanvas(text, opts); break;
          case 'bounce': canvas = createBounceCanvas(text, opts); break;
          case 'spiral': case 'galaxy': canvas = createSpiralCanvas(text, opts); break;
          case 'leak': canvas = createLeakCanvas(text, opts); break;
          default: canvas = createMatrixCanvas(text, opts); break;
        }
      }
    } finally { window._activeLoaderContext = false; }
    if (canvas) {
      if (opts.unbounded) {
        var existing = document.querySelectorAll('canvas.full-screen-anim');
        existing.forEach(function (c) {
          if (c._stopAnimation) { try { c._stopAnimation(); } catch (e) {} } else { c.remove(); }
        });
        canvas.className = 'pretext-canvas full-screen-anim';
        canvas.style.position = 'fixed';
        canvas.style.inset = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.zIndex = '10000';
        canvas.style.pointerEvents = 'none';
        canvas.style.background = 'transparent';
      } else {
        canvas.style.backgroundColor = (opts && opts.isSplash) ? 'var(--vscode-editor-background)' : getAnimationBgColor(undefined, opts);
      }
    }
    return canvas;
  }
  window.createAnimatedCanvas = createAnimatedCanvas;

})();
