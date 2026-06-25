/* ==========================================================================
   navigation.js — mouse thumb-button history for Junction webviews
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'junctionNavigation';
  var MAX_STACK = 80;
  var restoringUntil = 0;
  var data = load();

  function load() {
    try {
      var state = (vscode.getState && vscode.getState()) || {};
      var saved = state[KEY] || {};
      return {
        current: saved.current || null,
        back: Array.isArray(saved.back) ? saved.back : [],
        forward: Array.isArray(saved.forward) ? saved.forward : []
      };
    } catch (e) {
      return { current: null, back: [], forward: [] };
    }
  }

  function save() {
    try {
      var state = (vscode.getState && vscode.getState()) || {};
      state[KEY] = data;
      vscode.setState && vscode.setState(state);
    } catch (e) {}
  }

  function normalize(state) {
    state = state || {};
    return {
      view: state.view === 'home' ? 'home' : 'chat',
      bridgeId: String(state.bridgeId || window.junctionActiveBridge || '').trim() || undefined,
      sessionKey: String(state.sessionKey || window.junctionActiveSessionKey || '').trim() || undefined,
      title: String(state.title || '').trim() || undefined
    };
  }

  function same(a, b) {
    a = normalize(a);
    b = normalize(b);
    return a.view === b.view && a.bridgeId === b.bridgeId && a.sessionKey === b.sessionKey;
  }

  function record(next, opts) {
    opts = opts || {};
    next = normalize(Object.assign({}, data.current || {}, next || {}));
    if (!next.bridgeId && !next.sessionKey) return;

    if (opts.replace || Date.now() < restoringUntil) {
      data.current = next;
      save();
      return;
    }

    if (data.current && !same(data.current, next)) {
      data.back.push(data.current);
      if (data.back.length > MAX_STACK) data.back.shift();
      data.forward = [];
    }
    data.current = next;
    save();
  }

  function restore(direction) {
    var source = direction < 0 ? data.back : data.forward;
    var target = source.pop();
    if (!target) return;
    if (data.current) {
      (direction < 0 ? data.forward : data.back).push(data.current);
    }
    data.current = target;
    restoringUntil = Date.now() + 1500;
    save();
    vscode.postMessage({ type: 'restoreNavigation', state: target });
  }

  function handleMouseDown(event) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleMouseUp(event) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    restore(event.button === 3 ? -1 : 1);
  }

  window.junctionRecordNavigation = record;
  window.junctionReplaceNavigation = function (state) { record(state, { replace: true }); };
  window.junctionNavigationSnapshot = function () {
    return JSON.parse(JSON.stringify(data));
  };

  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('auxclick', handleMouseDown, true);
})();
