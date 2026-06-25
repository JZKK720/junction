/* ==========================================================================
   animation-registry.js — Shared animation defaults and mode metadata
   ========================================================================== */
(function () {
  'use strict';

  if (typeof window.JUNCTION_SHOW_LEGACY_ANIM === 'undefined') {
    window.JUNCTION_SHOW_LEGACY_ANIM = false;
  }

  var defaults = {
    // Defaults imported verbatim from the user's exported settings
    // (junction-animation-settings-template.json, exported 2026-06-23T16:59:39.753Z).
    speed: 1.0, fontSize: 1.0, density: 1.0, intensity: 1.0,
    loop: false, length: 2.0,
    bgColor: 'theme', bgAlpha: 0.0,
    widthMode: 'text', sizeOff: false, magic: false, curtainFade: 0.3,
    loaderMode: 'default',
    diffusionHeight: 1.0, noiseRes: 4, textFade: 0.5, cooling: 0.65, spread: 0.3,
    loaderSpeed: 1.0, loaderFontSize: 1.0, loaderDensity: 1.0, loaderIntensity: 1.0,
    loaderLength: 2.0, loaderBgColor: 'theme', loaderBgAlpha: 0.0,
    loaderLoop: true, loaderWidthMode: 'text', loaderSizeOff: false, loaderMagic: false,
    loaderNoiseRes: 4, loaderTextFade: 0.5, loaderCooling: 0.65, loaderSpread: 0.3,
    splashLength: 1.0, splashFade: 0.3, splashBackgroundFade: 0.9, splashBackgroundFadeDelay: 0, splashDisabled: false, splashAutoClose: false,
    splashExitMode: 'explode3', splashExitDuration: 1.9, splashExitForce: 0.7, splashExitSpread: 1.5, splashExitSpeed: 1, splashExitChaos: 2.3,
    splashExitMomentumX: 1.0, splashExitMomentumY: 1.5, splashExitExplode3BounceSides: true,
    splashExitExplode3YDamping: 0.35, splashExitExplode3GibSize: 1.0, splashExitExplode3GibSizeChaos: 1.2,
    splashExitStarwarsTargetY: -29,
    splashExitSpiralRadius: 0.7,
    splashExitFlattenHold: 55,
    splashExitSpiralLength: 1.2,
    splashExitExplode2Force: 1.0, splashExitExplode2Chaos: 0, splashExitExplode2HScale: 1.0, splashExitExplode2VScale: 1.0,
    splashCanvasExitDuration: 1.2,
    splashCharsetPreset: 'katakana', splashCharsetCustom: '',
    splashEmojiMix: true, splashEmojiRarity: 10000000,
    splashQuantity: 6.3, splashCharVariety: 1.0, splashMinOpacity: 0.2, splashMaxOpacity: 1.0,
    splashSizeVariance: 0.45, splashColorVariance: 0.32, splashBounce: 1.3, splashGravity: 0.2,
    splashRainDown: false, splashRainReverseChance: 0.0001, splashRainBounceSides: true, splashRainWaves: false,
    splashRainSpeed: 1.6, splashRainFlicker: 0.27, splashRainSpread: 1.0,
    splashWordmarkScale: 1.1, splashCollisionForce: 2.2, splashLogoLightness: 1.0,
    splashLogoWeight: 0.92, splashRainPushBounceSides: true, splashRainPushBias: 0.65, splashRainPushRotForce: 1,
    chatRiseDistance: 260, chatRiseDuration: 0.82, chatRiseTilt: 14, chatRiseBlur: 2,
    chatColorCustom: false,
    loaderColorCustom: false,
    splashColorCustom: false,
    splashFadeOnChatLoad: false,
    reactionPair: 'vector-arrows'
  };

  var animModes = ['matrix', 'zalgo', 'fire', 'bounce', 'spiral', 'galaxy', 'leak'];

  var sliderDefs = {
    'Force': { key: 'splashExitForce', min: 0.1, max: 16, step: 0.1, fallback: 1.0 },
    'Logo wt': { key: 'splashLogoWeight', min: 0, max: 1, step: 0.01, fallback: 1.0 },
    'Rain bias': { key: 'splashRainPushBias', min: 0, max: 1, step: 0.05, fallback: 0.65 },
    'Rot force': { key: 'splashRainPushRotForce', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'Spread': { key: 'splashExitSpread', min: 0.1, max: 20, step: 0.1, fallback: 1.0 },
    'Speed': { key: 'splashExitSpeed', min: 0.1, max: 4, step: 0.1, fallback: 1.0 },
    'Chaos': { key: 'splashExitChaos', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'Mom X': { key: 'splashExitMomentumX', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'Mom Y': { key: 'splashExitMomentumY', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'Y damp': { key: 'splashExitExplode3YDamping', min: 0, max: 1, step: 0.05, fallback: 0.35 },
    'Gib size': { key: 'splashExitExplode3GibSize', min: 0.5, max: 6, step: 0.1, fallback: 1.0 },
    'Gib chaos': { key: 'splashExitExplode3GibSizeChaos', min: 0, max: 4, step: 0.1, fallback: 1.2 },
    'Target Y': { key: 'splashExitStarwarsTargetY', min: -100, max: 100, step: 1, fallback: 0 },
    'Radius': { key: 'splashExitSpiralRadius', min: 0.1, max: 4, step: 0.1, fallback: 1.0 },
    'Length': { key: 'splashExitSpiralLength', min: 0, max: 2, step: 0.05, fallback: 1.0 },
    'E2 Force': { key: 'splashExitExplode2Force', min: 0.1, max: 4, step: 0.1, fallback: 1.0 },
    'E2 Chaos': { key: 'splashExitExplode2Chaos', min: 0, max: 4, step: 0.1, fallback: 0 },
    'H Scale': { key: 'splashExitExplode2HScale', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'V Scale': { key: 'splashExitExplode2VScale', min: 0, max: 4, step: 0.1, fallback: 1.0 },
    'Hold ms': { key: 'splashExitFlattenHold', min: 0, max: 100, step: 1, fallback: 0 }
  };

  var splashExitModes = {
    random: { label: 'Random', sliders: ['Force', 'Spread', 'Speed', 'Chaos'] },
    'spiral-out': { label: 'Spiral out', sliders: ['Spread', 'Speed'] },
    'spiral-in': { label: 'Spiral in', sliders: ['Speed', 'Radius', 'Length'] },
    explode: { label: 'Explode', sliders: ['Speed', 'Force'] },
    explode2: { label: 'Explode 2', sliders: ['Speed', 'E2 Force', 'E2 Chaos', 'H Scale', 'V Scale'] },
    melt: { label: 'Melt', sliders: ['Speed', 'Force', 'Chaos', 'Gib size', 'Gib chaos'] },
    'float-away': { label: 'Float away', sliders: ['Speed', 'Force', 'Spread', 'Chaos'] },
    'horizontal-flatten': { label: 'Horizontal flatten', sliders: ['Speed', 'Spread', 'Hold ms'] },
    'explode-weak': { label: 'Explode weak', sliders: ['Speed', 'Force'] },
    'starwars-crawl': { label: 'Starwars crawl', sliders: ['Speed', 'Target Y'] },
    explode3: { label: 'Explode 3 pixels', sliders: ['Speed', 'Chaos', 'Mom X', 'Mom Y', 'Y damp', 'Gib size', 'Gib chaos'] },
    'rain-push': { label: 'Rain push', sliders: ['Speed', 'Force', 'Logo wt', 'Rain bias', 'Rot force'] }
  };

  var previewSplashExitModes = [
    'spiral-out', 'spiral-in', 'explode', 'explode2', 'melt', 'float-away',
    'horizontal-flatten', 'explode-weak', 'starwars-crawl', 'explode3-bounce',
    'explode3-no-bounce'
  ];

  var randomSplashExitModes = previewSplashExitModes.concat([
    'rain-push', 'rain-push', 'rain-push', 'rain-push'
  ]);

  function normalizeSplashExitMode(mode) {
    if (mode === 'explode3-bounce') return { mode: 'explode3', explode3BounceSides: true };
    if (mode === 'explode3-no-bounce') return { mode: 'explode3', explode3BounceSides: false };
    return { mode: mode || 'random' };
  }

  function getSplashExitSliderLabels(mode) {
    var entry = splashExitModes[mode] || splashExitModes.random;
    return entry ? entry.sliders.slice() : [];
  }

  window.JunctionAnimation = Object.assign(window.JunctionAnimation || {}, {
    defaults: defaults,
    animModes: animModes,
    sliderDefs: sliderDefs,
    splashExitModes: splashExitModes,
    previewSplashExitModes: previewSplashExitModes,
    randomSplashExitModes: randomSplashExitModes,
    normalizeSplashExitMode: normalizeSplashExitMode,
    getSplashExitSliderLabels: getSplashExitSliderLabels
  });
})();
