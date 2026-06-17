/* Shared recursive webview choice menu. */
(function () {
  'use strict';

  var panels = [];
  var itemLists = [];
  var activeIndexes = [];
  var activeOptions = null;
  var returnFocus = null;
  var activeLevel = 0;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function firstEnabled(items) {
    return (items || []).findIndex(function (item) { return !item.disabled; });
  }

  function hasChildren(item) {
    return !!item && Array.isArray(item.children) && item.children.length > 0;
  }

  function close() {
    closeFrom(0);
    document.removeEventListener('mousedown', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    itemLists = [];
    activeIndexes = [];
    activeOptions = null;
    activeLevel = 0;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
    returnFocus = null;
  }

  function closeFrom(level) {
    for (var i = panels.length - 1; i >= level; i--) {
      if (panels[i]) panels[i].remove();
    }
    panels.length = level;
    itemLists.length = level;
    activeIndexes.length = level;
    if (activeLevel >= level) activeLevel = Math.max(0, level - 1);
  }

  function open(anchorEl, options) {
    close();
    if (!anchorEl) return;

    returnFocus = anchorEl;
    activeOptions = options || {};
    itemLists = [Array.isArray(activeOptions.items) ? activeOptions.items : []];
    activeIndexes = [firstEnabled(itemLists[0])];
    activeLevel = 0;
    panels[0] = renderPanel(0, activeOptions.title || '', !!activeOptions.loading, activeOptions.emptyText);
    document.body.appendChild(panels[0]);
    wireItems(0);
    positionRoot(anchorEl);

    setTimeout(function () {
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
    }, 0);
  }

  function renderPanel(level, title, loading, emptyText) {
    var items = itemLists[level] || [];
    var panel = document.createElement('div');
    panel.className = 'choice-menu' + (level > 0 ? ' choice-menu-submenu' : '');
    panel.setAttribute('role', 'listbox');

    var html = title ? '<div class="choice-menu-header">' + escapeHtml(title) + '</div>' : '';
    if (loading) {
      panel.innerHTML = html + '<div class="choice-menu-state">Loading...</div>';
      return panel;
    }
    if (!items.length) {
      panel.innerHTML = html + '<div class="choice-menu-state">' + escapeHtml(emptyText || 'No choices') + '</div>';
      return panel;
    }

    html += '<div class="choice-menu-scroll">';
    var lastSection = null;
    items.forEach(function (item, index) {
      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        html += '<div class="choice-menu-section">' + escapeHtml(item.section) + '</div>';
      }
      var classes = 'choice-menu-item' + (index === activeIndexes[level] ? ' active' : '');
      var icon = item.icon ? 'codicon-' + item.icon : 'codicon-blank';
      var marker = hasChildren(item) ? 'codicon-chevron-right' : (item.checked ? 'codicon-check' : 'codicon-blank');
      html += '<button class="' + classes + '" data-level="' + level + '" data-index="' + index + '" role="option"' +
        (hasChildren(item) ? ' aria-haspopup="listbox"' : '') +
        (item.disabled ? ' disabled' : '') + '>' +
        '<span class="codicon ' + icon + '"></span>' +
        '<span class="choice-menu-item-main">' +
        '<span class="choice-menu-item-label">' + escapeHtml(item.label || item.id) + '</span>' +
        (item.description ? '<span class="choice-menu-item-description">' + escapeHtml(item.description) + '</span>' : '') +
        '</span>' +
        '<span class="codicon ' + marker + '"></span>' +
        '</button>';
    });
    html += '</div>';
    panel.innerHTML = html;
    return panel;
  }

  function wireItems(level) {
    var panel = panels[level];
    if (!panel) return;
    panel.querySelectorAll('.choice-menu-item').forEach(function (button) {
      button.addEventListener('mouseenter', function () {
        var index = Number(button.dataset.index);
        var item = (itemLists[level] || [])[index];
        if (!item || item.disabled) return;
        setActive(level, index);
        closeFrom(level + 1);
      });
      button.addEventListener('mousedown', function (event) {
        event.preventDefault();
      });
      button.addEventListener('click', function (event) {
        var index = Number(button.dataset.index);
        var item = (itemLists[level] || [])[index];
        if (!item || item.disabled) return;
        // Click on chevron arrow → open submenu; click elsewhere → select directly
        var target = event.target;
        var isChevron = target.classList && target.classList.contains('codicon-chevron-right');
        if (hasChildren(item)) {
          if (isChevron || typeof item.action !== 'function') {
            openSubmenu(level, index, true);
          } else {
            // Select the item's default action (first child, or the item itself)
            selectIndex(level, index);
          }
        } else {
          selectIndex(level, index);
        }
      });
    });
  }

  function positionRoot(anchorEl) {
    var panel = panels[0];
    if (!panel) return;
    var rect = anchorEl.getBoundingClientRect();
    var width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
    panel.style.width = width + 'px';
    var panelRect = panel.getBoundingClientRect();
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - panelRect.width - 8);
    var aboveTop = rect.top - panelRect.height - 6;
    var belowTop = rect.bottom + 6;
    var placement = activeOptions && activeOptions.placement;
    var top = placement === 'above'
      ? aboveTop
      : (aboveTop >= 8 ? aboveTop : Math.min(belowTop, window.innerHeight - panelRect.height - 8));
    panel.style.left = left + 'px';
    panel.style.top = Math.min(Math.max(8, top), window.innerHeight - panelRect.height - 8) + 'px';
  }

  function positionSubmenu(level, parentButton) {
    var child = panels[level + 1];
    if (!child) return;
    var rect = parentButton.getBoundingClientRect();
    child.style.width = Math.min(280, window.innerWidth - 16) + 'px';
    var childRect = child.getBoundingClientRect();
    var rightLeft = rect.right + 4;
    var leftLeft = rect.left - childRect.width - 4;
    var left = rightLeft + childRect.width <= window.innerWidth - 8 ? rightLeft : Math.max(8, leftLeft);
    var top = Math.min(Math.max(8, rect.top - 1), window.innerHeight - childRect.height - 8);
    child.style.left = left + 'px';
    child.style.top = Math.max(8, top) + 'px';
  }

  function setActive(level, index) {
    activeIndexes[level] = index;
    activeLevel = level;
    var panel = panels[level];
    if (!panel) return;
    panel.querySelectorAll('.choice-menu-item').forEach(function (button) {
      button.classList.toggle('active', Number(button.dataset.index) === activeIndexes[level]);
    });
  }

  function openSubmenu(level, index, activate) {
    var item = (itemLists[level] || [])[index];
    if (!hasChildren(item)) return;
    closeFrom(level + 1);
    itemLists[level + 1] = item.children;
    activeIndexes[level + 1] = firstEnabled(item.children);
    panels[level + 1] = renderPanel(level + 1, item.label || item.id, false, 'No choices');
    document.body.appendChild(panels[level + 1]);
    wireItems(level + 1);
    var parentButton = panels[level] && panels[level].querySelector('.choice-menu-item[data-index="' + index + '"]');
    if (parentButton) positionSubmenu(level, parentButton);
    if (activate) activeLevel = level + 1;
  }

  function move(delta) {
    var items = itemLists[activeLevel] || [];
    if (!items.length) return;
    closeFrom(activeLevel + 1);
    var next = activeIndexes[activeLevel];
    for (var i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) {
        setActive(activeLevel, next);
        var active = panels[activeLevel] && panels[activeLevel].querySelector('.choice-menu-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }

  function selectIndex(level, index) {
    var item = (itemLists[level] || [])[index];
    if (!item || item.disabled) return;
    if (hasChildren(item)) {
      openSubmenu(level, index, true);
      return;
    }
    if (typeof item.action === 'function') {
      item.action(item);
      close();
      return;
    }
    var messageType = activeOptions && activeOptions.selectMessage;
    if (messageType) {
      var payload = {};
      for (var l = 0; l < level; l++) {
        var parent = itemLists[l] && itemLists[l][activeIndexes[l]];
        if (parent) payload = Object.assign(payload, parent);
      }
      payload = Object.assign(payload, item);
      payload.path = [];
      for (var p = 0; p <= level; p++) {
        var pathItem = itemLists[p] && itemLists[p][p === level ? index : activeIndexes[p]];
        if (pathItem && pathItem.id) payload.path.push(pathItem.id);
      }
      delete payload.children;
      vscode.postMessage(Object.assign({ type: messageType }, payload));
    }
    close();
  }

  function onOutsideClick(event) {
    for (var i = 0; i < panels.length; i++) {
      if (panels[i] && panels[i].contains(event.target)) return;
    }
    close();
  }

  function onKeydown(event) {
    if (!panels.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      var item = itemLists[activeLevel] && itemLists[activeLevel][activeIndexes[activeLevel]];
      if (hasChildren(item)) {
        event.preventDefault();
        openSubmenu(activeLevel, activeIndexes[activeLevel], true);
      }
    } else if (event.key === 'ArrowLeft') {
      if (activeLevel > 0) {
        event.preventDefault();
        closeFrom(activeLevel);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectIndex(activeLevel, activeIndexes[activeLevel]);
    }
  }

  window.choiceMenu = { open: open, close: close };
  window.ocwMenu = window.choiceMenu;
})();
