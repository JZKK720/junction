/* ==========================================================================
   animations.js — Pretext canvas animation renderer (matrix, zalgo, fire,
                    bounce, spiral, galaxy, leak, matrix-loader, fly-anim)
   ========================================================================== */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // LEGACY ANIMATION SETTINGS FLAG  (default: OFF)
  // --------------------------------------------------------------------------
  // Scopes the settings PREVIEWER to splash-only: when false, the previewer's
  // Chat + Bobber tabs (and their config sections in config-section.js) are
  // hidden, leaving just the Splash tab. Flip to `true` to bring those tabs
  // back. The live chat animations (working curtain, rise-in, fork loader) are
  // unaffected by this flag — only the settings UI is scoped.
  // ──────────────────────────────────────────────────────────────────────────
  var animationRegistry = window.JunctionAnimation;
  if (!animationRegistry || !animationRegistry.defaults) {
    throw new Error('JunctionAnimation registry missing');
  }

  var messagesDiv_a = document.getElementById('chat-messages');
  var matrixChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,.<>?/~`';
  var splashEmojiChars = [
    // Smileys & emotion
    '😀😃😄😁😆😅😂🤣🥲😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥸🤩🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🫣🤭🫢🫡🤫🫠🤥😶🫥😐🫤😑🙄😯😦😧😮😲🥱😴🤤😪😮‍💨😵😵‍💫🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿👹👺🤡💩👻💀☠👽👾🤖🎃🙈🙉🙊😺😸😹😻😼😽🙀😿😾💋💌💘💝💖💗💓💞💕💟❣💔❤️‍🔥❤️‍🩹❤🩷🧡💛💚💙🩵💜🤎🖤🩶🤍💯💢💥💫💦💨🕳💬👁‍🗨🗨🗯💭💤',
    // Animals & nature
    '🐵🐒🦍🦧🐶🐕🦮🐕‍🦺🐩🐺🦊🦝🐱🐈🐈‍⬛🦁🐯🐅🐆🐴🫎🫏🐎🦄🦓🦌🦬🐮🐂🐃🐄🐷🐖🐗🐽🐏🐑🐐🐪🐫🦙🦒🐘🦣🦏🦛🐭🐁🐀🐹🐰🐇🐿🦫🦔🦇🐻🐻‍❄🐨🐼🦥🦦🦨🦘🦡🐾🦃🐔🐓🐣🐤🐥🐦🐧🕊🦅🦆🦢🦉🦤🪶🦩🦚🦜🪽🐦‍⬛🪿🐸🐊🐢🦎🐍🐲🐉🦕🦖🐳🐋🐬🦭🐟🐠🐡🦈🐙🐚🪸🪼🐌🦋🐛🐜🐝🪲🐞🦗🪳🕷🕸🦂🦟🪰🪱🦠💐🌸💮🪷🏵🌹🥀🌺🌻🌼🌷🪻🌱🪴🌲🌳🌴🌵🌾🌿☘🍀🍁🍂🍃🪹🪺🍄🌰🦀🦞🦐🦑',
    // Food & drink
    '🍇🍈🍉🍊🍋🍌🍍🥭🍎🍏🍐🍑🍒🍓🫐🥝🍅🫒🥥🥑🍆🥔🥕🌽🌶🫑🥒🥬🥦🧄🧅🥜🫘🌰🫚🫛🍞🥐🥖🫓🥨🥯🥞🧇🧀🍖🍗🥩🥓🍔🍟🍕🌭🥪🌮🌯🫔🥙🧆🥚🍳🥘🍲🫕🥣🥗🍿🧈🧂🥫🍱🍘🍙🍚🍛🍜🍝🍠🍢🍣🍤🍥🥮🍡🥟🥠🥡🦪🍦🍧🍨🍩🍪🎂🍰🧁🥧🍫🍬🍭🍮🍯🍼🥛☕🫖🍵🍶🍾🍷🍸🍹🍺🍻🥂🥃🫗🥤🧋🧃🧉🧊🥢🍽🍴🥄🔪🫙🏺'
  ].join('');
  var splashCharsets = {
    matrix: matrixChars,
    latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    katakana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
    hiragana: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    cjk: '天地玄黄宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏龍虎山川風火雷電零壹貳參肆伍陸柒捌玖拾',
    hangul: '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허',
    binary: '010101110011001011010101',
    symbols: '@#$%^&*()_+-=[]{}<>/\\\\|;:,.~`',
    emoji: splashEmojiChars
  };
  var SPLASH_RARE_EMOJI_CHANCE = 0.00001; // 0.001%
  var PretextAPI = window.Pretext || null;
  var extraRichEnabled = true; // default on
  var ZALGO_SPLASH_MARKS = ['̍','̎','̄','̅','̿','̑','̐','̒','̓','̔','̽','̾','̀','́','̂','̃','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐'];

  /** Get font string from computed style. */
  function getCurrentFont() {
    var s = getComputedStyle(document.body);
    return (s.fontWeight || '400') + ' ' + (s.fontSize || '13px') + ' ' + (s.fontFamily || 'monospace');
  }

  function splitSplashChars(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      var segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(String(text || '')), function (part) { return part.segment; });
    }
    return Array.from(String(text || ''));
  }

  // ── Animation control defaults ──────────────────────────────────────────────
  var animConfig = Object.assign({}, animationRegistry.defaults);
  window.animConfig = animConfig;
  window.SPLASH_CHARSETS = splashCharsets;

  // Warm the Good Fonts faces so canvas wordmark rendering (Comic Neue in emoji
  // splash mode) doesn't fall back on first paint.
  if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
    try {
      document.fonts.load('600 24px "Junction Comic Neue"');
      document.fonts.load('400 16px "Junction Comic Mono"');
    } catch (e) { /* non-fatal */ }
  }

  var ANIM_MODES = (animationRegistry.animModes || ['matrix','zalgo','fire','bounce','spiral','galaxy','leak']).slice();
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
    Array.from(str || '').forEach(function (ch) {
      if (seen[ch]) return;
      seen[ch] = true;
      out += ch;
    });
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
    // The `junction.feedbackGlyphs` setting is the source of truth; fall back to
    // the legacy animation-panel value, then the codicon default.
    var mode = window.feedbackGlyphs
      || (window.animConfig && window.animConfig.reactionPair)
      || 'vector-arrows';
    switch (mode) {
      case 'faces': return { up: '😊', down: '😠' };
      case 'words': return { up: 'good', down: 'bad' };
      case 'hearts': return { up: '❤️', down: '💔' };
      case 'arrows': return { up: '⬆️', down: '⬇️' };
      case 'thumbs': return { up: 'codicon:thumbsup', down: 'codicon:thumbsdown' };
      case 'emoji-thumbs': return { up: '👍', down: '👎' };
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
  function shouldLoopAnimation(localOpts) {
    return !!(localOpts && localOpts.isSplash) || !!(localOpts && localOpts.loop) || !!getAnimVal('loop', false, localOpts);
  }

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

  /* ==========================================================================
     ╔════════════════════════════════════════════════════════════════════════╗
     ║  NON-SPLASH CANVAS MODES                                                 ║
     ║  fire · bounce · spiral · galaxy · matrix · zalgo · leak                 ║
     ║  Drive the live chat curtain (working.js), the fork loader (messages.js) ║
     ║  and the previewer's Chat/Bobber tabs via createAnimatedCanvas().        ║
     ╚════════════════════════════════════════════════════════════════════════╝
     ========================================================================== */

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
        if (shouldLoopAnimation(opts)) {
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
        if (shouldLoopAnimation(opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
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
        if (shouldLoopAnimation(opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
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
        if (shouldLoopAnimation(opts)) {
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
        if (shouldLoopAnimation(opts)) { startTime = performance.now(); initColumns(); animId = requestAnimationFrame(frame); }
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
        if (shouldLoopAnimation(opts)) { startTime = performance.now(); animId = requestAnimationFrame(frame); }
        else { done = true; ctx.clearRect(0, 0, tw, th); if (!opts.isSplash && !opts.unbounded) { ctx.font = fontStr; ctx.fillStyle = fgColor; lines.forEach(function (line, i) { ctx.fillText(line, 10, (i + 1) * lineHeight); }); } }
      }
    }
    animId = requestAnimationFrame(frame);
    canvas._stopAnimation = function () { done = true; if (animId) cancelAnimationFrame(animId); canvas.width = 0; canvas.height = 0; };
    return canvas;
  }

  /* ==========================================================================
     ╔════════════════════════════════════════════════════════════════════════╗
     ║  SPLASH ANIMATION  —  SHIPPING  (ignores JUNCTION_SHOW_LEGACY_ANIM)      ║
     ║  Junction wordmark + character rain + exit physics. Entry point is       ║
     ║  createMatrixLoader(..., { isSplash:true }) via createAnimatedCanvas.     ║
     ║  (The non-splash branch of createMatrixLoader served the legacy fork      ║
     ║   loader, now gated off in messages.js.)                                  ║
     ╚════════════════════════════════════════════════════════════════════════╝
     ========================================================================== */

  // ── Matrix loader (splash wordmark + boot states) ─────────────────────────
  function buildSplashWordmarkMask(canvas, text) {
    if (!canvas) return null;
    var wordmarkText = text || 'Junction';
    var bodyStyle = getComputedStyle(document.body);
    var scale = safeNumber(animConfig.splashWordmarkScale, 1);
    var fontSize = Math.round(Math.max(24, Math.min(96, canvas.width * 0.12, canvas.height * 0.2)) * scale);
    // Emoji splash mode always renders the "Junction" wordmark in Comic Neue.
    var wordmarkFamily = animConfig.splashCharsetPreset === 'emoji'
      ? '"Junction Comic Neue", ' + (bodyStyle.fontFamily || 'sans-serif')
      : (bodyStyle.fontFamily || 'sans-serif');
    // Logo letter weight: 1.0 = original 600 weight, scaling down toward 0.
    var logoWeight = clamp(Math.round(safeNumber(animConfig.splashLogoWeight, 1) * 600), 1, 900);
    var font = logoWeight + ' ' + fontSize + 'px ' + wordmarkFamily;
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
    var chars = [];
    var startX = canvas.width / 2 - measured.width / 2;
    var advance = 0;
    for (var i = 0; i < wordmarkText.length; i++) {
      var ch = wordmarkText.charAt(i);
      var w = measureCtx.measureText(ch).width;
      var entry = { ch: ch, x: startX + advance + w / 2, y: canvas.height / 2 };
      // Per-letter pixel mask: the glyph rendered centered on its own little
      // bitmap. Collision tests this mask at the letter's CURRENT position, so
      // the rain only ever hits the actual letters — never the combined blob.
      var lw = Math.max(1, Math.ceil(w + fontSize * 0.4));
      var lh = height;
      var loff = document.createElement('canvas');
      loff.width = lw;
      loff.height = lh;
      var lctx = loff.getContext('2d');
      if (lctx) {
        lctx.clearRect(0, 0, lw, lh);
        lctx.fillStyle = '#fff';
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.font = font;
        lctx.fillText(ch, lw / 2, lh / 2);
        entry.maskData = lctx.getImageData(0, 0, lw, lh).data;
        entry.maskW = lw;
        entry.maskH = lh;
      }
      chars.push(entry);
      advance += w;
    }
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
      chars: chars,
      canvas: offscreen,
      data: data,
      hit: function (x, y) {
        var lx = Math.floor(x - left);
        var ly = Math.floor(y - top);
        if (lx < 0 || ly < 0 || lx >= width || ly >= height) return false;
        return data[(ly * width + lx) * 4 + 3] > 24;
      },
      hitInfo: function (x, y) {
        var lx = Math.floor(x - left);
        var ly = Math.floor(y - top);
        if (lx < 0 || ly < 0 || lx >= width || ly >= height) return null;
        if (data[(ly * width + lx) * 4 + 3] <= 24) return null;
        var nearest = 0;
        var nearestDist = Infinity;
        for (var c = 0; c < chars.length; c++) {
          var d = Math.abs(chars[c].x - x);
          if (d < nearestDist) { nearestDist = d; nearest = c; }
        }
        return { index: nearest, x: x, y: y };
      },
      // Per-letter hit test. `positions` (optional) gives each letter's current
      // center {x,y}; defaults to the resting layout. Returns the topmost letter
      // index whose own mask contains (px,py), or -1.
      // Test one letter's mask at (cx,cy). `pad` widens the probe into a small
      // cross so a drop whose glyph merely OVERLAPS a thin stroke (i, T) — or a
      // big emoji centered just off a lit pixel — still counts as a hit.
      letterHitAt: function (charIndex, px, py, cx, cy, pad) {
        var c = chars[charIndex];
        if (!c || !c.maskData) return false;
        var offs = pad > 0
          ? [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad],
             [pad * 0.7, pad * 0.7], [-pad * 0.7, pad * 0.7], [pad * 0.7, -pad * 0.7], [-pad * 0.7, -pad * 0.7]]
          : [[0, 0]];
        for (var o = 0; o < offs.length; o++) {
          var lx = Math.floor(px + offs[o][0] - (cx - c.maskW / 2));
          var ly = Math.floor(py + offs[o][1] - (cy - c.maskH / 2));
          if (lx < 0 || ly < 0 || lx >= c.maskW || ly >= c.maskH) continue;
          if (c.maskData[(ly * c.maskW + lx) * 4 + 3] > 24) return true;
        }
        return false;
      },
      letterHitIndex: function (px, py, positions, pad) {
        for (var i = chars.length - 1; i >= 0; i--) {
          var c = chars[i];
          if (!c.maskData) continue;
          var cx = (positions && positions[i]) ? positions[i].x : c.x;
          var cy = (positions && positions[i]) ? positions[i].y : c.y;
          if (this.letterHitAt(i, px, py, cx, cy, pad || 0)) return i;
        }
        return -1;
      }
    };
  }

  function drawSplashWordmark(ctx, mask, opts, motion) {
    if (!ctx || !mask) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = mask.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = getAnimColor(opts);
    if (motion && mask.chars && mask.chars.length === motion.length) {
      for (var i = 0; i < mask.chars.length; i++) {
        var glyph = mask.chars[i];
        var m = motion[i];
        ctx.fillText(glyph.ch, glyph.x + m.x, glyph.y + m.y);
      }
    } else {
      ctx.fillText(mask.text, mask.textX, mask.textY);
    }
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

    // Splash rain scales with the CANVAS size (not the chat/body font), so the
    // preview and the real splash stay proportional at any size. getAnimFontSize
    // (the loader font slider) stays as an optional multiplier. Non-splash
    // matrix loaders keep the old fixed size.
    var fontSize = opts.isSplash
      ? Math.max(3, Math.round(canvas.height * 0.014 * getAnimFontSize(opts)))
      : Math.round(11 * getAnimFontSize(opts));
    ctx.font = fontSize + 'px monospace';
    var splashQuantity = opts.isSplash ? clamp(safeNumber(animConfig.splashQuantity, 1.4), 0.3, 4) : 1;
    var cols = Math.max(2, Math.floor((canvas.width / fontSize) * getAnimDensity(opts) * splashQuantity));
    var wordmarkMask = opts.isSplash ? buildSplashWordmarkMask(canvas, opts.text || 'Junction') : null;
    var splashCharset = opts.isSplash ? getSplashCharset() : matrixChars;
    var splashCharsetChars = splitSplashChars(splashCharset);
    var splashCharVariety = clamp(safeNumber(animConfig.splashCharVariety, 1.0), 0.05, 1);
    var splashVarietyLength = Math.max(1, Math.ceil(splashCharsetChars.length * splashCharVariety));
    var splashVarietyCharset = splashCharsetChars.slice(0, splashVarietyLength);
    var rareEmojiCharset = splitSplashChars(splashCharsets.emoji);
    var splashEffect = opts.splashEffect || 'matrix';
    var splashMinOpacity = clamp(safeNumber(animConfig.splashMinOpacity, 0.2), 0.02, 1);
    var splashMaxOpacity = clamp(safeNumber(animConfig.splashMaxOpacity, 0.9), splashMinOpacity, 1);
    var splashSizeVariance = clamp(safeNumber(animConfig.splashSizeVariance, 0.45), 0, 1.4);
    var splashColorVariance = clamp(safeNumber(animConfig.splashColorVariance, 0.32), 0, 1);
    var splashBounce = clamp(safeNumber(animConfig.splashBounce, 1.1), 0, 3);
    var splashGravity = clamp(safeNumber(animConfig.splashGravity, 1.0), 0.1, 4);
    var splashCollisionForce = clamp(safeNumber(animConfig.splashCollisionForce, 1.4), 0, 4);
    var splashLogoLightness = clamp(safeNumber(animConfig.splashLogoLightness, 1.0), 0.05, 4);
    var splashColorBase = parseRgbaColor(getAnimColor(opts));
    var drops = [];
    var wordmarkMotion = [];
    var splashExit = null;
    var splashDropsVisible = true;   // any rain drop still on screen (gates exit completion)
    var rainStop = false;            // true → rain stops respawning (keeps its normal speed, never fades)
    var splashIntroStartedAt = Date.now();
    var splashIntroFadeMs = opts.isSplash ? 520 : 0;
    // Resolution scale for exit physics: 1 at the real splash (canvas == viewport),
    // < 1 in the smaller settings preview. Every absolute px velocity/force/offset
    // in the exit is multiplied by this so the letters take the SAME time to fly
    // off regardless of canvas size (preview matches the live splash exactly).
    var exitScale = canvas.height / (window.innerHeight || canvas.height || 1);
    var exitGlyphs = [];
    var exitParticles = [];
    var i;

    function syncWordmarkMotion(mask) {
      var count = mask && mask.chars ? mask.chars.length : 0;
      while (wordmarkMotion.length < count) wordmarkMotion.push({ x: 0, y: 0, vx: 0, vy: 0 });
      if (wordmarkMotion.length > count) wordmarkMotion.length = count;
    }

    function applyWordmarkPhysics() {
      for (var i = 0; i < wordmarkMotion.length; i++) {
        var m = wordmarkMotion[i];
        m.vx += -m.x * 0.08 / splashLogoLightness;
        m.vy += -m.y * 0.08 / splashLogoLightness;
        m.vx *= 0.82;
        m.vy *= 0.82;
        m.x += m.vx;
        m.y += m.vy;
        var limit = fontSize * 0.32 * splashLogoLightness;
        m.x = clamp(m.x, -limit, limit);
        m.y = clamp(m.y, -limit, limit);
      }
    }

    function hitWordmark(drop, hit) {
      if (!hit || !wordmarkMotion[hit.index]) return;
      var m = wordmarkMotion[hit.index];
      var mass = splashCollisionForce * (drop.scale || 1);
      var light = splashLogoLightness;
      var side = hit.x < wordmarkMask.centerX ? -1 : 1;
      m.vx += side * mass * light * 0.55;
      m.vy += Math.max(-1.8, drop.vy) * mass * light * 0.45;
    }

    function randomSplashChar() {
      if (animConfig.splashEmojiMix) {
        var rarity = Math.max(1, Math.round(animConfig.splashEmojiRarity || 100));
        if (Math.random() < 1 / rarity) {
          return rareEmojiCharset[Math.floor(Math.random() * rareEmojiCharset.length)];
        }
      } else if (Math.random() < SPLASH_RARE_EMOJI_CHANCE) {
        // The rare emoji roll permanently unlocks the Good Fonts pack — flip the
        // persisted junction.goodFonts setting, not just this session's class.
        try {
          document.body.classList.add('good-fonts');
          vscode.postMessage({ type: 'setGoodFonts', value: true });
        } catch (e) {}
        return rareEmojiCharset[Math.floor(Math.random() * rareEmojiCharset.length)];
      }
      var ch = splashVarietyCharset[Math.floor(Math.random() * splashVarietyCharset.length)];
      if (animConfig.splashCharsetPreset === 'emoji') return ch;
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

    function splashEntryY(goesDown) {
      var rainSpread = clamp(safeNumber(animConfig.splashRainSpread, 1), 0, 4);
      var bandBase = animConfig.splashRainWaves ? canvas.height * 0.25 : canvas.height;
      var band = bandBase * rainSpread * Math.random();
      return goesDown
        ? (-fontSize * (0.5 + Math.random() * 0.5) - band)
        : (canvas.height + fontSize * (0.5 + Math.random() * 0.5) + band);
    }

    function splashIntroAlpha() {
      if (!splashIntroFadeMs) return 1;
      return clamp((Date.now() - splashIntroStartedAt) / splashIntroFadeMs, 0, 1);
    }

    for (i = 0; i < cols; i++) {
      var laneX = (i + 0.5) * (canvas.width / cols);
      var initDown = !!animConfig.splashRainDown;
      var initRev = clamp(safeNumber(animConfig.splashRainReverseChance, 0.0001), 0, 100);
      if (Math.random() < initRev / 100) initDown = !initDown;
      var drop = {
        x: laneX,
        laneX: laneX,
        // First splash frame must enter from an edge. Seeding across the field
        // made rain pop into the middle after the fallback wordmark swapped out.
        y: splashEntryY(initDown),
        vy: (initDown ? 1 : -1) * (0.8 + Math.random() * 1.6) * getAnimIntensity(opts) * splashGravity,
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
      if (splashExit && splashExit.rainPushDone) { drop.dead = true; return; }
      drop.x = drop.laneX + (Math.random() - 0.5) * fontSize * 0.12;
      var goesDown = !!animConfig.splashRainDown;
      var revChance = clamp(safeNumber(animConfig.splashRainReverseChance, 0.0001), 0, 100);
      if (Math.random() < revChance / 100) goesDown = !goesDown;
      // Off-screen respawn band. Stream mode (default) uses a wide band so
      // re-entry stays decorrelated (steady trickle); waves uses a narrow one.
      // Spread scales it — wider = sparser/more staggered, tighter = denser.
      drop.y = splashEntryY(goesDown);
      drop.vy = (goesDown ? 1 : -1) * (0.8 + Math.random() * 1.4) * splashGravity;
      drop.vx = (Math.random() - 0.5) * 0.04;
      drop.ch = randomSplashChar();
      assignSplashStyle(drop);
    }

    function exitValue(key, fallback, min, max) {
      return clamp(safeNumber(animConfig[key], fallback), min, max);
    }

    function buildExitGlyphs(mask, exit) {
      var chars = mask && mask.chars ? mask.chars : [];
      var count = Math.max(1, chars.length - 1);
      return chars.map(function (glyph, index) {
        var dx = glyph.x - mask.centerX;
        var spreadAngle = -Math.PI + (Math.PI * 2 * index / count);
        var baseAngle = Math.atan2((Math.random() - 0.5) * mask.height * exit.chaos, dx || (Math.random() - 0.5));
        var angle = (baseAngle * 0.65) + (spreadAngle * 0.35);
        var power = exit.force * (0.7 + Math.random() * 0.65);
        return {
          ch: glyph.ch,
          baseX: glyph.x,
          baseY: glyph.y,
          x: glyph.x,
          y: glyph.y,
          vx: Math.cos(angle) * 360 * power * exit.spread * exitScale,
          vy: (Math.sin(angle) * 260 * power * exit.spread - 80 * exit.force) * exitScale,
          rot: 0,
          vrot: (Math.random() - 0.5) * 8 * exit.chaos,
          phase: Math.random() * Math.PI * 2,
          spreadSlot: (index + 0.5) / chars.length,
          angle: angle
        };
      });
    }

    function buildMaskParticles(mask, exit, mode) {
      if (!mask || !mask.data) return [];
      var particles = [];
      var maxParticles = mode === 'explode3' ? 2600 : (mode === 'melt' ? 1800 : 340);
      var explode3GibSize = clamp(safeNumber(animConfig.splashExitExplode3GibSize, 1), 0.5, 6);
      var explode3GibChaos = clamp(safeNumber(animConfig.splashExitExplode3GibSizeChaos, 0.6), 0, 4);
      var explode3YDamping = clamp(safeNumber(animConfig.splashExitExplode3YDamping, 0.35), 0, 1);
      var step = mode === 'explode3'
        ? Math.max(1, Math.round(Math.ceil(Math.sqrt((mask.width * mask.height) / maxParticles)) * explode3GibSize))
        : (mode === 'melt' ? Math.max(1, Math.round(Math.ceil(Math.sqrt((mask.width * mask.height) / maxParticles)) * explode3GibSize)) : Math.max(2, Math.ceil(mask.width / 80)));
      for (var y = 0; y < mask.height; y += step) {
        for (var x = 0; x < mask.width; x += step) {
          var alpha = mask.data[(y * mask.width + x) * 4 + 3];
          if (alpha <= 24) continue;
          if (mode !== 'explode3' && mode !== 'melt') {
            var edge = Math.min(x, mask.width - x);
            if (edge > mask.width * 0.22 && Math.random() > 0.18) continue;
          }
          var sx = mask.left + x;
          var sy = mask.top + y;
          var dx = sx - mask.centerX;
          var dy = sy - (mask.top + mask.height / 2);
          var angle = Math.atan2(dy, dx || (Math.random() - 0.5));
          if (mode === 'melt') angle = Math.PI / 2 + (Math.random() - 0.5) * 0.9;
          var force = exit.force * (0.45 + Math.random() * 0.85);
          if (mode === 'explode3') {
            var chaosAngle = (Math.random() - 0.5) * exit.chaos * 1.2;
            angle += chaosAngle;
            force = exit.force * (0.9 + Math.random() * (1.25 + exit.chaos * 0.25));
          }
          var vy = Math.sin(angle) * 320 * force * exit.spread * exitScale;
          if (mode === 'melt') {
            var meltDepth = y / Math.max(1, mask.height);
            force = exit.force * (0.35 + Math.random() * 0.45);
            vy = (90 + 160 * Math.random() + 120 * meltDepth) * force * exitScale;
          }
          var vx = (Math.cos(angle) * 420 * force * exit.spread + (Math.random() - 0.5) * 90 * exit.chaos) * exitScale;
          if (mode === 'explode3') {
            var speed = (360 + Math.random() * 540) * force * exitScale;
            vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 180 * exit.chaos * exitScale;
            vy = (Math.sin(angle) * speed - (120 + Math.random() * 220) * exitScale) * (1 - explode3YDamping);
          }
          if (mode === 'melt') {
            vx = (Math.random() - 0.5) * (30 + 60 * exit.chaos) * exitScale;
          }
          var particleSize = (mode === 'explode3' || mode === 'melt')
            ? Math.max(1, Math.round(step * Math.max(0.25, 1 + (Math.random() * 2 - 1) * explode3GibChaos * 0.35)))
            : Math.max(1, step * 0.7);
          particles.push({
            x: sx,
            y: sy,
            baseX: sx,
            baseY: sy,
            vx: vx,
            vy: vy,
            size: particleSize,
            delay: mode === 'melt' ? ((y / Math.max(1, mask.height)) * 0.35 + Math.random() * 0.18) : (Math.random() * (mode === 'explode3' ? 0.08 : 0.18)),
            rot: Math.random() * Math.PI * 2,
            vrot: (Math.random() - 0.5) * (8 + exit.chaos * 10),
            alpha: 1
          });
          if (particles.length >= maxParticles) return particles;
        }
      }
      return particles;
    }

    function startSplashExit(request) {
      if (!opts.isSplash || splashExit) return;
      var mode = (request && request.mode) || animConfig.splashExitMode || 'random';
      var explode3BounceOverride = null;
      if (mode === 'random') {
        var modes = animationRegistry.randomSplashExitModes || ['spiral-out', 'spiral-in', 'explode', 'explode2', 'melt', 'float-away', 'horizontal-flatten', 'explode-weak', 'starwars-crawl', 'explode3-bounce', 'explode3-no-bounce', 'rain-push', 'rain-push', 'rain-push', 'rain-push'];
        mode = modes[Math.floor(Math.random() * modes.length)];
      }
      var normalizedMode = animationRegistry.normalizeSplashExitMode ? animationRegistry.normalizeSplashExitMode(mode) : { mode: mode };
      mode = normalizedMode.mode;
      if (normalizedMode.explode3BounceSides !== undefined) explode3BounceOverride = normalizedMode.explode3BounceSides;
      wordmarkMask = buildSplashWordmarkMask(canvas, opts.text || 'Junction') || wordmarkMask;
      splashExit = {
        mode: mode,
        start: performance.now(),
        last: performance.now(),
        duration: exitValue('splashExitDuration', 1.6, 0.3, 4),
        force: exitValue('splashExitForce', 1.0, 0.1, 16),
        spread: exitValue('splashExitSpread', 1.0, 0.1, 4),
        speed: exitValue('splashExitSpeed', 1.0, 0.1, 4),
        chaos: exitValue('splashExitChaos', 1.0, 0, 4)
      };
      if (explode3BounceOverride !== null) splashExit.explode3BounceSides = explode3BounceOverride;
      exitGlyphs = buildExitGlyphs(wordmarkMask, splashExit);
      exitParticles = (mode === 'explode3' || mode === 'melt') ? buildMaskParticles(wordmarkMask, splashExit, mode) : [];
      if (mode === 'rain-push') {
        splashExit.rainPushDone = false;
        exitGlyphs.forEach(function (g) {
          g.x = g.baseX;
          g.y = g.baseY;
          g.vx = (Math.random() - 0.5) * 8;
          g.vy = (Math.random() - 0.5) * 8;
        });
      }
      canvas.setAttribute('data-splash-exit-mode', mode);
      // Every mode keeps raining through the exit; the rain only stops respawning
      // (and starts draining) once the last letter has left the screen — set
      // below in drawSplashExit when the wordmark is no longer visible.
      rainStop = false;
    }
    canvas._startSplashExit = startSplashExit;

    canvas._isSplashExitComplete = function () {
      // Not done until the glyphs have left AND the rain has drained off-screen,
      // so the loader is never torn down while drops are still visible.
      if (splashExit === false) return !splashDropsVisible;
      if (!splashExit) return false;
      return (splashExit.progress || 0) >= 1 && splashExit.visible === false && !splashDropsVisible;
    };

    function drawExitGlyph(ctx, glyph, x, y, scaleX, scaleY, rotation, alpha, exit) {
      if (alpha <= 0 || scaleX <= 0 || scaleY <= 0) return;
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.translate(x, y);
      ctx.rotate(rotation || 0);
      ctx.scale(scaleX, scaleY);
      ctx.fillText(glyph.ch, 0, 0);
      ctx.restore();
    }

    function drawSplashExit(ctx, mask) {
      if (!splashExit || !mask) return false;
      var now = performance.now();
      var raw = ((now - splashExit.start) / 1000) * splashExit.speed / splashExit.duration;
      splashExit.progress = raw;
      splashExit.visible = false;
      var ease = 1 - Math.exp(-raw * 3);
      var p = ease;
      var travel = raw;
      ctx.save();
      ctx.font = mask.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = getAnimColor(opts);

      if (splashExit.mode === 'explode3' || splashExit.mode === 'melt') {
        var isMelt = splashExit.mode === 'melt';
        var momX = isMelt ? 1 : clamp(safeNumber(animConfig.splashExitMomentumX, 1.0), 0, 4);
        var momY = isMelt ? 1 : clamp(safeNumber(animConfig.splashExitMomentumY, 1.0), 0, 4);
        var dt3 = Math.min(0.05, Math.max(0.001, (now - (splashExit.last || splashExit.start)) / 1000)) * splashExit.speed;
        var elapsed3 = ((now - splashExit.start) / 1000) * splashExit.speed;
        var gravity3 = (isMelt ? 460 * Math.max(0.25, splashExit.force) : 780 * Math.max(0.35, momY)) * exitScale;
        var bounceSides3 = !isMelt && (splashExit.explode3BounceSides !== undefined ? !!splashExit.explode3BounceSides : !!animConfig.splashExitExplode3BounceSides);
        ctx.fillStyle = getAnimColor(opts);
        exitParticles.forEach(function (part) {
          if (part.done) return;
          if (elapsed3 < part.delay) {
            splashExit.visible = true;
            ctx.globalAlpha = 1;
            ctx.fillRect(part.x, part.y, part.size, part.size);
            return;
          }
          part.vy += gravity3 * dt3;
          part.vx += (Math.random() - 0.5) * splashExit.chaos * (isMelt ? 35 : 90) * exitScale * dt3;
          part.vy += (Math.random() - 0.5) * splashExit.chaos * (isMelt ? 18 : 45) * exitScale * dt3;
          part.vx *= Math.pow(isMelt ? 0.965 : 0.992, dt3 * 60);
          part.vy *= Math.pow(isMelt ? 0.992 : 0.997, dt3 * 60);
          part.x += part.vx * dt3 * momX;
          part.y += part.vy * dt3 * Math.max(0.15, momY);
          part.rot += part.vrot * dt3;
          part.vrot *= Math.pow(0.975, dt3 * 60);
          if (bounceSides3) {
            if (part.x < 0) {
              part.x = 0;
              part.vx = Math.abs(part.vx) * (0.62 + Math.random() * 0.2);
              part.vy *= 0.94;
              part.vrot += part.vy * 0.01;
            } else if (part.x > canvas.width - part.size) {
              part.x = canvas.width - part.size;
              part.vx = -Math.abs(part.vx) * (0.62 + Math.random() * 0.2);
              part.vy *= 0.94;
              part.vrot -= part.vy * 0.01;
            }
          }
          if (!isMelt && !bounceSides3 && (part.x < -part.size || part.x > canvas.width + part.size)) part.done = true;
          else if (part.y <= canvas.height + part.size * 2) splashExit.visible = true;
          else part.done = true;
          var px = part.x;
          var py = part.y;
          ctx.globalAlpha = 1;
          if (px > -part.size && px < canvas.width + part.size && py > -part.size && py < canvas.height + part.size) {
            ctx.save();
            ctx.translate(px + part.size / 2, py + part.size / 2);
            ctx.rotate(part.rot || 0);
            ctx.fillRect(-part.size / 2, -part.size / 2, part.size, part.size);
            ctx.restore();
          }
        });
        ctx.restore();
        splashExit.last = now;
        if (!splashExit.visible) {
          splashExit._offCount = (splashExit._offCount || 0) + 1;
        } else {
          splashExit._offCount = 0;
        }
        if (splashExit._offCount > 30) {
          rainStop = true;
          splashExit = false;
        }
        return true;
      }

      exitGlyphs.forEach(function (glyph, index) {
        var x = glyph.baseX;
        var y = glyph.baseY;
        var sx = 1;
        var sy = 1;
        var rot = glyph.vrot * p * 0.18;
        var alpha = 1;
        if (splashExit.mode === 'spiral-out') {
          var radius = (20 + 520 * splashExit.spread * travel) * exitScale * (0.65 + Math.abs(index - exitGlyphs.length / 2) / exitGlyphs.length);
          var angle = glyph.angle + travel * Math.PI * 4 * splashExit.speed;
          x = mask.centerX + Math.cos(angle) * radius;
          y = mask.textY + Math.sin(angle) * radius;
        } else if (splashExit.mode === 'spiral-in') {
          var radiusScale = clamp(safeNumber(animConfig.splashExitSpiralRadius, 1.0), 0.1, 4);
          var lengthScale = clamp(safeNumber(animConfig.splashExitSpiralLength, 1.0), 0, 2);
          var startRadius = (Math.abs(glyph.baseX - mask.centerX) + mask.width * 0.45) * radiusScale;
          var convergence = ease * lengthScale;
          var inAngle = glyph.angle + ease * Math.PI * 5 * splashExit.speed;
          x = mask.centerX + Math.cos(inAngle) * startRadius * (1 - convergence);
          y = mask.textY + Math.sin(inAngle) * startRadius * (1 - convergence);
          sx = sy = Math.max(0.005, Math.pow(1 - ease, 1.8));
        } else if (splashExit.mode === 'explode') {
          x += glyph.vx * travel * 0.9 + Math.sign(glyph.vx || (glyph.baseX - mask.centerX) || 1) * canvas.width * 0.5 * travel * travel;
          y += glyph.vy * travel * 0.9 + 150 * exitScale * travel * travel;
        } else if (splashExit.mode === 'explode2') {
          if (!glyph._e2Init) {
            glyph._e2Init = true;
            var hScale = clamp(safeNumber(animConfig.splashExitExplode2HScale, 1.0), 0, 4);
            var vScale = clamp(safeNumber(animConfig.splashExitExplode2VScale, 1.0), 0, 4);
            glyph.vx *= hScale;
            glyph.vy *= vScale;
          }
          var e2Force = clamp(safeNumber(animConfig.splashExitExplode2Force, 1.0), 0.1, 4);
          var e2Chaos = clamp(safeNumber(animConfig.splashExitExplode2Chaos, 0), 0, 4);
          var dt = Math.min(0.05, (now - splashExit.last) / 1000) * splashExit.speed;
          glyph.vy += 520 * exitScale * dt * e2Force;
          glyph.vx += (Math.random() - 0.5) * e2Chaos * dt * 100 * exitScale;
          glyph.vy += (Math.random() - 0.5) * e2Chaos * dt * 50 * exitScale;
          glyph.x += glyph.vx * dt;
          glyph.y += glyph.vy * dt;
          if (glyph.x < 8 || glyph.x > canvas.width - 8) {
            glyph.x = clamp(glyph.x, 8, canvas.width - 8);
            glyph.vx *= -0.78;
          }
          x = glyph.x;
          y = glyph.y;
          alpha = y > canvas.height + 40 ? 0 : 1;
        } else if (splashExit.mode === 'float-away') {
          var dxTravel = Math.cos(travel * 9 + glyph.phase) * 55 * exitScale * splashExit.spread * splashExit.chaos;
          var dyTravel = -(canvas.height + mask.height + 80 * exitScale * splashExit.force);
          x += dxTravel + (glyph.spreadSlot - 0.5) * 90 * exitScale * travel;
          y += dyTravel * travel;
          var dirAngle = Math.atan2(dyTravel, dxTravel + (glyph.spreadSlot - 0.5) * 90 * exitScale);
          rot = dirAngle * 0.35 * clamp(splashExit.chaos, 0.2, 1) + Math.sin(travel * 8 + glyph.phase) * 0.15 * splashExit.chaos;
        } else if (splashExit.mode === 'horizontal-flatten') {
          var holdMs = clamp(safeNumber(animConfig.splashExitFlattenHold, 0), 0, 100);
          x = glyph.baseX + ((canvas.width * glyph.spreadSlot) - glyph.baseX) * ease;
          sx = 1 + splashExit.spread * ease * 0.7;
          sy = Math.max(0.0001, 1 - ease);
          rot = 0;
          if (sy < 0.002 && !splashExit._flattenMinAt) splashExit._flattenMinAt = now;
          if (splashExit._flattenMinAt && (now - splashExit._flattenMinAt) < holdMs) {
            splashExit.visible = true;
          }
        } else if (splashExit.mode === 'explode-weak') {
          x += glyph.vx * travel * 0.18;
          y += Math.abs(glyph.vy) * travel * 0.15 + (canvas.height + mask.height) * travel * travel * 0.75;
          rot = glyph.vrot * travel * 0.08;
        } else if (splashExit.mode === 'starwars-crawl') {
          var targetX = canvas.width / 2;
          var targetYAdd = safeNumber(animConfig.splashExitStarwarsTargetY, 0);
          var targetY = clamp(targetYAdd, -100, 100) / 100 * canvas.height;
          x = glyph.baseX + (targetX - glyph.baseX) * ease;
          y = glyph.baseY + (targetY - glyph.baseY) * ease;
          sx = sy = Math.max(0.015, Math.pow(1 - ease, 2.2));
          rot = -0.18 * ease;
	        } else if (splashExit.mode === 'rain-push') {
          if (!glyph._rpInit) {
            glyph._rpInit = true;
            glyph.x = glyph.baseX;
            glyph.y = glyph.baseY;
            glyph.vx = (Math.random() - 0.5) * 8 * exitScale;
            glyph.vy = (Math.random() - 0.5) * 8 * exitScale;
            glyph.vrot = 0;
            glyph.rot = 0;
          }
          var dt = Math.min(0.05, (now - (splashExit.last || splashExit.start)) / 1000);
          var lmask = mask.chars[index];
          var rpRotForce = clamp(safeNumber(animConfig.splashRainPushRotForce, 1), 0, 4);
          drops.forEach(function (drop) {
            if (drop.dead || !lmask || !lmask.maskData) return;
            // Push only when the drop is actually inside THIS letter's mask at
            // its current position — collide with the loose letter, nothing else.
            if (!mask.letterHitAt(index, drop.x + fontSize * 0.3, drop.y - fontSize * 0.35, glyph.x, glyph.y, fontSize * 0.5)) return;
            var dx = glyph.x - drop.x;
            var dy = glyph.y - drop.y;
            var dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
            var force = 60 * exitScale * splashExit.force;
            var pushX = dx / dist;
            var pushY = dy / dist;
            // Bias the push toward the rain's travel direction, so letters get
            // carried along with the flow instead of just scattering radially.
            var rvLen = Math.sqrt(drop.vx * drop.vx + drop.vy * drop.vy);
            if (rvLen > 0.0001) {
              var rainBias = clamp(safeNumber(animConfig.splashRainPushBias, 0.65), 0, 1);
              pushX = pushX * (1 - rainBias) + (drop.vx / rvLen) * rainBias;
              pushY = pushY * (1 - rainBias) + (drop.vy / rvLen) * rainBias;
            }
            glyph.vx += pushX * force * dt;
            glyph.vy += pushY * force * dt;
            // Off-center hit spins the letter (2D torque = lever × applied force).
            // Both lever and force carry exitScale, so divide it back out to keep
            // the rotation amount the same at any canvas size.
            if (rpRotForce > 0) {
              var torque = (drop.x - glyph.x) * (pushY * force) - (drop.y - glyph.y) * (pushX * force);
              glyph.vrot += torque * rpRotForce * 0.00004 * dt / (exitScale * exitScale || 1);
            }
          });
          glyph.vx *= 0.985;
          glyph.vy *= 0.985;
          glyph.rot = (glyph.rot || 0) + (glyph.vrot || 0) * dt;
          glyph.vrot = (glyph.vrot || 0) * 0.96;   // angular damping
          glyph.x += glyph.vx * dt * 60;
          glyph.y += glyph.vy * dt * 60;
          if (animConfig.splashRainPushBounceSides) {
            // Bounce off the left/right walls only — no gravity. The rain keeps
            // pushing until every letter leaves off the top or bottom edge.
            if (glyph.x < 0) { glyph.x = 0; glyph.vx = Math.abs(glyph.vx) * 0.8; }
            else if (glyph.x > canvas.width) { glyph.x = canvas.width; glyph.vx = -Math.abs(glyph.vx) * 0.8; }
            x = glyph.x;
            y = glyph.y;
            alpha = (y >= -mask.height && y <= canvas.height + mask.height) ? 1 : 0;   // gone off top or bottom
          } else {
            x = glyph.x;
            y = glyph.y;
            alpha = (y >= 0 && y <= canvas.height && x >= 0 && x <= canvas.width) ? 1 : 0;  // slide off any side
	          }
	          rot = glyph.rot || 0;   // impact-driven spin
	        }
	        glyph._drawX = x;
	        glyph._drawY = y;
	        if (splashExit.mode === 'rain-push') {
          if (alpha > 0) splashExit.visible = true;
        } else if (alpha > 0 && sx > 0.02 && sy > 0.02 && x > -mask.height && x < canvas.width + mask.height && y > -mask.height && y < canvas.height + mask.height) {
          splashExit.visible = true;
        }
        drawExitGlyph(ctx, glyph, x, y, sx, sy, rot, alpha, splashExit);
      });
      splashExit.last = now;
      if (splashExit.mode === 'rain-push') {
        // Every letter is off screen → push done. Stop spawning new rain; the
        // remaining drops keep falling at their normal speed until they leave.
        // Complete only once they've actually left — never delete on-screen rain.
        if (!splashExit.visible && raw > 1) {
          splashExit.rainPushDone = true;
          rainStop = true;
        }
        if (rainStop) {
          var rpAnyOn = false;
          for (var rpi = 0; rpi < drops.length; rpi++) {
            var rpd = drops[rpi];
            if (!rpd.dead && rpd.y > -fontSize * 4 && rpd.y < canvas.height + fontSize * 4 &&
                rpd.x > -fontSize * 4 && rpd.x < canvas.width + fontSize * 4) { rpAnyOn = true; break; }
          }
          if (!rpAnyOn) splashExit = false;
        }
      } else {
        if (!splashExit.visible) {
          splashExit._offCount = (splashExit._offCount || 0) + 1;
          rainStop = true;   // last letter has left → stop spawning rain, let it drain
        } else {
          splashExit._offCount = 0;
        }
        if (splashExit._offCount > 30) splashExit = false;
      }
      ctx.restore();
      return true;
    }

    function drawSplashLoader() {
      // splashExit lifecycle: null = intro (wordmark up), object = exit running,
      // false = exit glyphs done. After the glyphs leave we must NOT redraw the
      // intro wordmark (that was the post-exit flash bug), but we DO keep
      // animating the rain off-screen — on-screen glyphs must drain away, they
      // must never pop out.
      var exiting = splashExit !== null;            // exit started (running or done)
      wordmarkMask = buildSplashWordmarkMask(canvas, opts.text || 'Junction') || wordmarkMask;
      if (!splashExit) {
        syncWordmarkMotion(wordmarkMask);
        applyWordmarkPhysics();
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Current center of each resting letter (rest layout + physics jitter), so
      // the rain collides with each letter's own mask at where it's actually drawn.
	      var letterPositions = null;
	      if (!splashExit && wordmarkMask && wordmarkMask.chars) {
	        letterPositions = wordmarkMask.chars.map(function (c, i) {
	          var m = wordmarkMotion[i];
	          return { x: c.x + (m ? m.x : 0), y: c.y + (m ? m.y : 0) };
	        });
	      }
	      var exitLetterPositions = null;
	      if (splashExit && splashExit !== false && wordmarkMask && wordmarkMask.chars &&
	          splashExit.mode !== 'explode3' && splashExit.mode !== 'melt') {
	        exitLetterPositions = wordmarkMask.chars.map(function (c, i) {
	          var g = exitGlyphs[i];
	          return { x: (g && g._drawX !== undefined) ? g._drawX : c.x, y: (g && g._drawY !== undefined) ? g._drawY : c.y };
	        });
	      }
	      function hitExitParticle(px, py, pad) {
	        if (!splashExit || splashExit === false || (splashExit.mode !== 'explode3' && splashExit.mode !== 'melt')) return null;
	        for (var epi = exitParticles.length - 1; epi >= 0; epi--) {
	          var part = exitParticles[epi];
	          if (!part || part.done) continue;
	          if (px >= part.x - pad && px <= part.x + part.size + pad &&
	              py >= part.y - pad && py <= part.y + part.size + pad) {
	            return part;
	          }
	        }
	        return null;
	      }

      var rainSpeed = clamp(safeNumber(animConfig.splashRainSpeed, 1), 0.1, 4);
      var rainFlicker = clamp(safeNumber(animConfig.splashRainFlicker, 0.16), 0, 1);
      drops.forEach(function (drop) {
        drop.ch = Math.random() < rainFlicker ? randomSplashChar() : drop.ch;
        drop.vy -= 0.015 * getAnimSpeed(opts) * splashGravity;
        drop.vx *= 0.88;
        // Draining never changes the rain's speed: once rainStop is set the drops
        // simply stop respawning and keep falling at their normal pace until they
        // leave the screen. (No acceleration — the rain looks identical before,
        // during, and after every exit mode.)
        if (!animConfig.splashRainBounceSides) drop.vx += (drop.laneX - drop.x) * 0.0025;
        var nextX = drop.x + drop.vx * fontSize;
        var nextY = drop.y + drop.vy * fontSize * 0.36 * getAnimSpeed(opts) * rainSpeed;
	        // Hit-test the drop against whatever is visibly blocking it RIGHT NOW:
	        // resting letters before dismissal, moving loose letters during glyph
	        // exits, and pixel bodies during explode3/melt. Never use the old baked
	        // whole-word mask after the user presses start.
	        if (!drop.behind && wordmarkMask && wordmarkMask.letterHitIndex) {
	          var probeX = nextX + fontSize * 0.3;
	          var probeY = nextY - fontSize * 0.35;
	          var pad = fontSize * 0.5;
	          var hitCenter = null;
	          var _li = -1;
	          if (!splashExit && letterPositions) {
	            _li = wordmarkMask.letterHitIndex(probeX, probeY, letterPositions, pad);
	            if (_li >= 0) {
	              hitCenter = letterPositions[_li];
	              hitWordmark(drop, { index: _li, x: nextX, y: nextY });
	            }
	          } else if (splashExit && splashExit !== false && exitLetterPositions) {
	            _li = wordmarkMask.letterHitIndex(probeX, probeY, exitLetterPositions, pad);
	            if (_li >= 0) hitCenter = exitLetterPositions[_li];
	          } else {
	            var hitPart = hitExitParticle(probeX, probeY, pad);
	            if (hitPart) hitCenter = { x: hitPart.x + hitPart.size / 2, y: hitPart.y + hitPart.size / 2 };
	          }
	          if (hitCenter) {
	            var side = nextX < hitCenter.x ? -1 : 1;
	            var shove = fontSize * (0.04 + splashCollisionForce * 0.02 + splashBounce * (0.03 + Math.random() * 0.05));
	            nextX += side * shove;
	            drop.vx += side * shove * 0.015;
	          }
	        }
        drop.x = nextX;
        drop.y = nextY;
        var offscreen = drop.x < -fontSize || drop.x > canvas.width + fontSize ||
                        drop.y < -fontSize * 4 || drop.y > canvas.height + fontSize;
        if (exiting) {
          if (offscreen) {
            if (rainStop) {
              // Draining (all modes): a drop that has left the screen stays gone
              // — no respawn, no teleport. It exited; it never disappeared on-screen.
              drop.dead = true;
            } else {
              // rain-push still pushing letters: keep raining (respawn).
              resetSplashDrop(drop);
            }
          }
        } else if (animConfig.splashRainBounceSides) {
          if (drop.x < 0) { drop.x = 0; drop.vx = Math.abs(drop.vx) * 0.7; }
          if (drop.x > canvas.width) { drop.x = canvas.width; drop.vx = -Math.abs(drop.vx) * 0.7; }
          if (drop.y < -fontSize * 4 || drop.y > canvas.height + fontSize) resetSplashDrop(drop);
        } else if (offscreen) {
          resetSplashDrop(drop);
        }
      });

      [true].forEach(function (behindLayer) {
        drops.forEach(function (drop) {
          if (drop.behind !== behindLayer || drop.dead) return;
          ctx.globalAlpha = splashIntroAlpha();
          ctx.fillStyle = drop.fill;   // keep each drop's own varied colour/alpha — never recolour on exit
          ctx.font = Math.max(2, Math.round(fontSize * drop.scale)) + 'px monospace';
          ctx.fillText(drop.ch, drop.x, drop.y);
        });
      });
      if (splashExit) {
        drawSplashExit(ctx, wordmarkMask);                            // glyphs fly out; may flip splashExit=false
      } else if (splashExit === null) {
        drawSplashWordmark(ctx, wordmarkMask, opts, wordmarkMotion);  // intro only — never redraw after exit
      }
      [false].forEach(function (behindLayer) {
        drops.forEach(function (drop) {
          if (drop.behind !== behindLayer || drop.dead) return;
          ctx.globalAlpha = splashIntroAlpha();
          ctx.fillStyle = drop.fill;   // keep each drop's own varied colour/alpha — never recolour on exit
          ctx.font = Math.max(2, Math.round(fontSize * drop.scale)) + 'px monospace';
          ctx.fillText(drop.ch, drop.x, drop.y);
        });
      });
      ctx.globalAlpha = 1;
      splashDropsVisible = drops.some(function (d) { return !d.dead; });
      animId = requestAnimationFrame(drawSplashLoader);
    }

    var animId = null;
    function draw() {
      if (opts.isSplash) {
        drawSplashLoader();
        return;
      }
      if (canvas.closest && canvas.closest('#startup-loader.dismissed')) return;
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
  var animationCanvasFactories = {
    matrix: function (text, opts) { return createMatrixCanvas(text, opts); },
    zalgo: function (text, opts) { return createZalgoCanvas(text, opts); },
    fire: function (text, opts) { return createFireCanvas(text, opts); },
    bounce: function (text, opts) { return createBounceCanvas(text, opts); },
    spiral: function (text, opts) { return createSpiralCanvas(text, opts); },
    galaxy: function (text, opts) { return createSpiralCanvas(text, opts); },
    leak: function (text, opts) { return createLeakCanvas(text, opts); }
  };

  function createModeCanvas(mode, text, opts) {
    var factory = animationCanvasFactories[mode] || animationCanvasFactories.matrix;
    return factory(text, opts);
  }

  animationRegistry.canvasFactories = animationCanvasFactories;
  animationRegistry.createModeCanvas = createModeCanvas;

  function createAnimatedCanvas(text, opts) {
    opts = opts || {};
    if (opts.isSplash) opts = Object.assign({}, opts, { loop: true, loaderLoop: true });
    var mode = opts.mode || window._junctionAnimationMode || 'matrix';
    if (opts.loader) {
      var loaderMode = getAnimVal('loaderMode', 'default', opts);
      if (loaderMode !== 'default') mode = loaderMode;
    }
    if (opts.loader) window._activeLoaderContext = true;
    var canvas = null;
    try {
      if (opts.loader && opts.isSplash) {
        canvas = createMatrixLoader(opts.width, opts.height || 40, Object.assign({}, opts, { splashEffect: mode, text: text || 'Junction' }));
      }
      else if (opts.loader && mode === 'matrix') { canvas = createMatrixLoader(opts.width, opts.height || 40, opts); }
      else {
        canvas = createModeCanvas(mode, text, opts);
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
        canvas.style.backgroundColor = (opts && opts.isSplash) ? 'transparent' : getAnimationBgColor(undefined, opts);
      }
    }
    return canvas;
  }
  window.createAnimatedCanvas = createAnimatedCanvas;

})();
