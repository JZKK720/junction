/* ==========================================================================
   attached-files-bar.js — File pill bar + @-mention autocomplete
   ==========================================================================
   Appended to the bottom of template.html's <script> block at build time.
   Requires: vscode = acquireVsCodeApi(), DOM from template.html.
   ========================================================================== */

// ── State ────────────────────────────────────────────────────────────────
const filePillRegistry = new Map();      // filePath → pill DOM element
let livePillFile  = null;                // current live pill filePath (if enabled)

// ── @-mention autocomplete state ─────────────────────────────────────────
let mentionPopup      = null;
let mentionQuery      = '';
let mentionSelected   = -1;
let mentionItems      = [];

// ── Exported API ─────────────────────────────────────────────────────────

/**
 * Create or update the live-selection pill.
 * @param {{ filePath?: string, displayText?: string, enabled: boolean }} msg
 */
function updateLivePill({ filePath, displayText, enabled }) {
  const bar = document.getElementById('attached-files-bar');
  if (!bar) return;

  const existing = livePillFile ? filePillRegistry.get(livePillFile) : null;

  if (!enabled) {
    // Remove live pill entirely
    if (existing) {
      existing.remove();
      filePillRegistry.delete(livePillFile);
      livePillFile = null;
    }
    return;
  }

  // enabled && filePath must be present
  if (!filePath) return;

  if (existing && existing.dataset.filepath === filePath) {
    // Update label
    const label = existing.querySelector('.file-pill-label');
    if (label && displayText) label.textContent = displayText;
  } else {
    // Remove old live pill if switching files
    if (existing) {
      existing.remove();
      filePillRegistry.delete(livePillFile);
    }
    // Create new live pill
    const pill = createPillElement(filePath, displayText || filePath, true);
    pill.classList.add('enabled');
    bar.prepend(pill);
    filePillRegistry.set(filePath, pill);
  }

  livePillFile = filePath;
}

/**
 * Add or update a pill in the bar.
 * @param {{ filePath: string, displayText?: string, isLive?: boolean }} msg
 */
function addPill({ filePath, displayText, isLive }) {
  if (!filePath) return;
  const bar = document.getElementById('attached-files-bar');
  if (!bar) return;

  if (isLive) {
    // Delegate to live pill logic
    updateLivePill({ filePath, displayText, enabled: true });
    return;
  }

  // Manual pill: deduplicate by filePath
  const existing = filePillRegistry.get(filePath);
  if (existing) {
    // Already exists — update label if changed
    const label = existing.querySelector('.file-pill-label');
    if (label && displayText) label.textContent = displayText;
    return;
  }

  const pill = createPillElement(filePath, displayText || filePath, false);
  bar.appendChild(pill);
  filePillRegistry.set(filePath, pill);
}

// ── Pill creation ────────────────────────────────────────────────────────

/**
 * Create a pill DOM element.
 * @param {string} filePath
 * @param {string} displayText
 * @param {boolean} isLive
 * @returns {HTMLElement}
 */
function createPillElement(filePath, displayText, isLive) {
  const pill = document.createElement('div');
  pill.className = 'file-pill' + (isLive ? ' file-pill-live' : '');
  pill.dataset.filepath = filePath;
  pill.title = filePath;

  // Icon
  const icon = document.createElement('span');
  icon.className = 'codicon codicon-file file-pill-icon';

  // Label
  const label = document.createElement('span');
  label.className = 'file-pill-label';
  label.textContent = displayText;

  // Remove button
  const btn = document.createElement('button');
  btn.className = 'file-pill-remove codicon codicon-close';
  btn.title = isLive ? 'Disable live selection' : 'Remove file';
  btn.setAttribute('aria-label', isLive ? 'Disable live selection' : 'Remove file');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLive) {
      vscode.postMessage({ type: 'toggleLivePill', enabled: false });
    } else {
      removePill(filePath);
    }
  });

  pill.appendChild(icon);
  pill.appendChild(label);
  pill.appendChild(btn);
  return pill;
}

/**
 * Remove a pill by filePath and notify the extension.
 * @param {string} filePath
 */
function removePill(filePath) {
  const pill = filePillRegistry.get(filePath);
  if (!pill) return;

  pill.remove();
  filePillRegistry.delete(filePath);

  if (filePath === livePillFile) {
    livePillFile = null;
  }

  vscode.postMessage({ type: 'removePill', filePath });
}

// ── @-mention autocomplete ───────────────────────────────────────────────

const composerInput = document.getElementById('composer-input');

if (composerInput) {
  composerInput.addEventListener('keydown', onComposerKeydown);
  composerInput.addEventListener('input', onComposerInput);
}

/**
 * Handle keydown in composer for @-mention popup navigation.
 */
function onComposerKeydown(e) {
  if (!mentionPopup) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      mentionSelected = Math.min(mentionSelected + 1, mentionItems.length - 1);
      renderMentionSelection();
      break;
    case 'ArrowUp':
      e.preventDefault();
      mentionSelected = Math.max(mentionSelected - 1, 0);
      renderMentionSelection();
      break;
    case 'Enter':
      if (mentionSelected >= 0 && mentionSelected < mentionItems.length) {
        e.preventDefault();
        selectMentionItem(mentionItems[mentionSelected]);
      }
      break;
    case 'Escape':
      e.preventDefault();
      closeMentionPopup();
      break;
  }
}

/**
 * Handle input events on the composer — detect '@' and manage query.
 */
function onComposerInput() {
  const text  = composerInput.value;
  const pos   = composerInput.selectionStart;
  const before = text.substring(0, pos);

  // Find the last '@' that's not part of a word (preceded by whitespace or start)
  const atMatch = before.match(/(?:^|\s)@([^\s]*)$/);

  if (atMatch) {
    mentionQuery = atMatch[1];
    openMentionPopup(mentionQuery);
  } else {
    closeMentionPopup();
  }
}

/**
 * Open (or reposition) the file-mention popup.
 */
function openMentionPopup(query) {
  if (!composerInput) return;

  if (!mentionPopup) {
    mentionPopup = document.createElement('div');
    mentionPopup.className = 'file-mention-popup';
    document.body.appendChild(mentionPopup);

    // Close on outside click
    document.addEventListener('mousedown', onOutsideMentionClick, true);
  }

  // Position the popup above the composer
  const rect = composerInput.getBoundingClientRect();
  const caretY = estimateCaretY(rect);

  mentionPopup.style.left   = rect.left + 'px';
  mentionPopup.style.bottom = (window.innerHeight - rect.top) + 'px';
  mentionPopup.style.width  = Math.max(rect.width, 240) + 'px';

  // Request file matches from extension
  mentionPopup.innerHTML =
    '<div class="file-mention-popup-loading">Loading…</div>';
  mentionSelected = -1;
  mentionItems = [];

  vscode.postMessage({ type: 'listWorkspaceFiles', prefix: query });
}

/**
 * Position the popup and refresh after extension responds with file list.
 */
function handleWorkspaceFiles(files) {
  if (!mentionPopup) return;

  mentionItems = files || [];
  mentionSelected = mentionItems.length > 0 ? 0 : -1;
  renderMentionList();
}

/**
 * Render the full popup list.
 */
function renderMentionList() {
  if (!mentionPopup) return;

  if (mentionItems.length === 0) {
    mentionPopup.innerHTML =
      '<div class="file-mention-popup-empty">No matching files</div>';
    return;
  }

  const query = mentionQuery.toLowerCase();
  let html = '';
  mentionItems.forEach((f, i) => {
    let name  = f.name || f.path;
    let dir   = f.isDirectory ? f.path : (f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '');
    // For directories, show the full path as name
    if (f.isDirectory) {
      name = f.path + '/';
      dir  = '';
    }

    const selectedClass = i === mentionSelected ? ' selected' : '';
    html += `<div class="file-mention-popup-item${selectedClass}" data-index="${i}">
      <span class="codicon ${f.isDirectory ? 'codicon-folder' : 'codicon-file'}"></span>
      <span class="file-mention-popup-item-name">${escapeHtml(name)}</span>
      ${dir ? `<span class="file-mention-popup-item-path">${escapeHtml(dir)}</span>` : ''}
    </div>`;
  });

  mentionPopup.innerHTML = html;

  // Attach click handlers
  mentionPopup.querySelectorAll('.file-mention-popup-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur on composer
      const idx = parseInt(el.dataset.index, 10);
      if (idx >= 0 && idx < mentionItems.length) {
        selectMentionItem(mentionItems[idx]);
      }
    });
  });

  // Ensure popup doesn't overflow viewport top
  clampPopupPosition();
}

/**
 * Update selection highlight only (reuse existing DOM).
 */
function renderMentionSelection() {
  if (!mentionPopup) return;
  const items = mentionPopup.querySelectorAll('.file-mention-popup-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === mentionSelected);
  });

  // Scroll selected into view
  const selected = mentionPopup.querySelector('.file-mention-popup-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

/**
 * User picks a mention item.
 */
function selectMentionItem(file) {
  if (!composerInput) return;

  const text  = composerInput.value;
  const pos   = composerInput.selectionStart;
  const before = text.substring(0, pos);
  const atMatch = before.match(/(?:^|\s)@([^\s]*)$/);
  if (!atMatch) return;

  // Build mention text: @file/path
  const mentionText = '@' + file.path;
  const atIndex     = before.lastIndexOf(atMatch[0]);
  const newBefore   = text.substring(0, atIndex) + mentionText + ' ';
  const newAfter    = text.substring(pos);
  composerInput.value = newBefore + newAfter;

  // Move cursor after inserted text
  const cursorPos = atIndex + mentionText.length + 1;
  composerInput.setSelectionRange(cursorPos, cursorPos);
  composerInput.focus();

  // Add pill through extension
  vscode.postMessage({
    type: 'addPill',
    filePath: file.path,
    displayText: file.name || file.path,
    isLive: false,
  });

  closeMentionPopup();
}

/**
 * Close the popup and clean up.
 */
function closeMentionPopup() {
  if (mentionPopup) {
    mentionPopup.remove();
    mentionPopup = null;
    document.removeEventListener('mousedown', onOutsideMentionClick, true);
  }
  mentionQuery = '';
  mentionSelected = -1;
  mentionItems = [];
}

function onOutsideMentionClick(e) {
  if (mentionPopup && !mentionPopup.contains(e.target) && e.target !== composerInput) {
    closeMentionPopup();
  }
}

/**
 * Ensure the popup doesn't overflow the top of the viewport.
 */
function clampPopupPosition() {
  if (!mentionPopup) return;
  const popupRect = mentionPopup.getBoundingClientRect();
  if (popupRect.top < 0) {
    // Shift down
    const offset = -popupRect.top + 4;
    mentionPopup.style.bottom =
      (parseFloat(mentionPopup.style.bottom) - offset) + 'px';
    // If that makes it overflow bottom, clamp height
    if (popupRect.bottom + offset > window.innerHeight) {
      mentionPopup.style.maxHeight =
        (window.innerHeight - popupRect.top - offset - 8) + 'px';
    }
  }
}

/**
 * Estimate caret Y position for popup placement.
 */
function estimateCaretY(inputRect) {
  // Approximation using line height
  const lineHeight = 20; // px, matches typical VSCode webview input
  return inputRect.bottom - 4;
}

/**
 * Escape HTML entities in a string.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ── Message routing ──────────────────────────────────────────────────────

window.addEventListener('message', event => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'updateLivePill':
      updateLivePill(msg);
      break;

    case 'addPill':
      addPill(msg);
      break;

    case 'workspaceFiles':
      handleWorkspaceFiles(msg.files);
      break;

    // No default — other stages handle their own message types
  }
});

// ── Initial state sync (extension may send state after 'ready') ──────────
// The extension can call these functions via postMessage after the webview
// sends 'ready', so the bar is populated from persisted state on load.

function getPillCount() { return filePillRegistry.size; }

// ── Export to global scope (for innerHTML <script> execution) ─────────────
window.updateLivePill = updateLivePill;
window.addPill = addPill;
window.getPillCount = getPillCount;
