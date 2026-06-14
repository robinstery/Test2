'use strict';

// Guard against running twice on the same page (can happen with some SPAs)
if (window.__blgInjected) {
  // Already running — just stop here
} else {
  window.__blgInjected = true;
  runBlacklistGuardian();
}

function runBlacklistGuardian() {
  // ── State ──────────────────────────────────────────────────────────────────
  let entries = [];
  let termRegex = null;
  let entryMap = new Map(); // lowercase term → entry object
  let tooltipEl = null;
  let tooltipTimeout = null;
  let bannerEl = null;
  let observerDebounce = null;
  let mutationObserver = null;

  // Tags whose text content we never touch — scanning inside these would
  // either be useless (script/style) or break the page (input/textarea).
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'BUTTON', 'MARK', 'SVG', 'CANVAS', 'CODE', 'PRE'
  ]);

  // ── Storage helpers ────────────────────────────────────────────────────────

  function loadEntries() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['entries'], (result) => {
        resolve(result.entries || []);
      });
    });
  }

  function saveEntries(updatedEntries) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ entries: updatedEntries }, resolve);
    });
  }

  // ── Regex / lookup builder ─────────────────────────────────────────────────

  function buildMatcher(allEntries) {
    const active = allEntries.filter(e => e.enabled !== false);
    entryMap = new Map();
    if (active.length === 0) {
      termRegex = null;
      return;
    }

    active.forEach(e => entryMap.set(e.term.toLowerCase(), e));

    // Sort longer terms first so "Acme Corporation" matches before "Acme"
    const escaped = active
      .map(e => e.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);

    termRegex = new RegExp(`(${escaped.join('|')})`, 'gi');
  }

  // ── Page scanning & highlighting ───────────────────────────────────────────

  function removeHighlights() {
    // Replace every <mark class="blg-highlight"> with a plain text node,
    // then normalize() merges adjacent text nodes back to their original form.
    document.querySelectorAll('mark.blg-highlight').forEach(mark => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    document.body && document.body.normalize();
  }

  function scanNode(root) {
    if (!termRegex || !root) return new Set();

    const matched = new Set(); // entries found on this scan

    // TreeWalker visits every text node in the subtree efficiently
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // Skip nodes inside tags we don't want to touch
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          // Skip nodes already inside a highlight we injected
          if (parent.classList && parent.classList.contains('blg-highlight')) return NodeFilter.FILTER_REJECT;
          // Skip nodes inside our own banner / dialog
          if (parent.closest && parent.closest('#blg-banner, #blg-overlay, #blg-tooltip')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.textContent.trim() === '') return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Collect all matching text nodes first — we must not mutate the DOM while walking
    const nodesToProcess = [];
    let node;
    while ((node = walker.nextNode())) {
      termRegex.lastIndex = 0;
      if (termRegex.test(node.textContent)) {
        nodesToProcess.push(node);
      }
    }

    // Now process each node: split text around matches and insert <mark> elements
    nodesToProcess.forEach(textNode => {
      const text = textNode.textContent;
      const fragment = document.createDocumentFragment();
      termRegex.lastIndex = 0;
      let lastIndex = 0;
      let match;

      while ((match = termRegex.exec(text)) !== null) {
        const matchedText = match[0];
        const entry = entryMap.get(matchedText.toLowerCase());
        if (!entry) continue;

        matched.add(entry);

        // Text before the match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        // The highlighted element
        const mark = document.createElement('mark');
        mark.className = 'blg-highlight';
        mark.dataset.entryId = entry.id;
        mark.textContent = matchedText;
        mark.addEventListener('mouseenter', (e) => showTooltip(entry, e.clientX, e.clientY));
        mark.addEventListener('mousemove', (e) => repositionTooltip(e.clientX, e.clientY));
        mark.addEventListener('mouseleave', hideTooltip);
        fragment.appendChild(mark);

        lastIndex = match.index + matchedText.length;
      }

      if (lastIndex === 0) return; // no match found (shouldn't happen, but guard anyway)

      // Remaining text after the last match
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    });

    return matched;
  }

  function runFullScan() {
    if (!termRegex) {
      removeHighlights();
      removeBanner();
      return;
    }

    // Pause the mutation observer while we change the DOM ourselves
    if (mutationObserver) mutationObserver.disconnect();

    removeHighlights();
    removeBanner();

    const matched = scanNode(document.body);
    if (matched.size > 0) showBanner([...matched]);

    // Resume observing after our own changes settle
    if (mutationObserver) {
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Mutation Observer — re-scan new content as the page loads dynamically ──

  function setupMutationObserver() {
    mutationObserver = new MutationObserver((mutations) => {
      // Debounce: wait 500 ms after the last mutation before re-scanning.
      // Many pages fire dozens of mutations per second during load.
      clearTimeout(observerDebounce);
      observerDebounce = setTimeout(() => {
        if (!termRegex) return;

        // Pause observer, scan only newly added nodes, resume
        mutationObserver.disconnect();

        let anyNew = false;
        mutations.forEach(m => {
          m.addedNodes.forEach(n => {
            if (n.nodeType === Node.ELEMENT_NODE) {
              const found = scanNode(n);
              if (found.size > 0) anyNew = true;
            }
          });
        });

        if (anyNew) {
          // Re-collect all matched entries to update the banner
          const allMatched = new Set();
          document.querySelectorAll('mark.blg-highlight').forEach(mark => {
            const entry = entryMap.get(mark.textContent.toLowerCase());
            if (entry) allMatched.add(entry);
          });
          removeBanner();
          if (allMatched.size > 0) showBanner([...allMatched]);
        }

        mutationObserver.observe(document.body, { childList: true, subtree: true });
      }, 500);
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Banner ─────────────────────────────────────────────────────────────────

  function showBanner(matchedEntries) {
    removeBanner();

    const banner = document.createElement('div');
    banner.id = 'blg-banner';

    const icon = document.createElement('span');
    icon.id = 'blg-banner-icon';
    icon.textContent = '⚠️';

    const textWrap = document.createElement('div');
    textWrap.id = 'blg-banner-text';

    const termsEl = document.createElement('div');
    termsEl.id = 'blg-banner-terms';

    // Show up to 3 term names; if more, add "and N more"
    const names = matchedEntries.map(e => e.term);
    const displayNames = names.slice(0, 3);
    const extra = names.length - displayNames.length;

    termsEl.innerHTML = 'Blacklist Guardian: This page mentions '
      + displayNames.map(n => `<em>${escapeHtml(n)}</em>`).join(', ')
      + (extra > 0 ? ` and ${extra} more` : '');

    textWrap.appendChild(termsEl);

    const actions = document.createElement('div');
    actions.id = 'blg-banner-actions';

    const listBtn = document.createElement('button');
    listBtn.id = 'blg-banner-list-btn';
    listBtn.textContent = 'View my list';
    listBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });

    const closeBtn = document.createElement('button');
    closeBtn.id = 'blg-banner-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', removeBanner);

    actions.appendChild(listBtn);
    actions.appendChild(closeBtn);

    banner.appendChild(icon);
    banner.appendChild(textWrap);
    banner.appendChild(actions);

    document.body.insertBefore(banner, document.body.firstChild);
    bannerEl = banner;
  }

  function removeBanner() {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = 'blg-tooltip';
      tooltipEl.innerHTML = `
        <div id="blg-tooltip-term"></div>
        <div id="blg-tooltip-reason"></div>
        <div id="blg-tooltip-source"></div>
        <div id="blg-tooltip-date"></div>
      `;
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function showTooltip(entry, x, y) {
    clearTimeout(tooltipTimeout);
    const tip = ensureTooltip();

    tip.querySelector('#blg-tooltip-term').textContent = entry.term;
    tip.querySelector('#blg-tooltip-reason').textContent = entry.reason || 'No reason recorded.';

    const sourceEl = tip.querySelector('#blg-tooltip-source');
    if (entry.sourceTitle || entry.sourceUrl) {
      sourceEl.textContent = 'Source: ' + (entry.sourceTitle || entry.sourceUrl);
    } else {
      sourceEl.textContent = 'Added manually';
    }

    const dateEl = tip.querySelector('#blg-tooltip-date');
    if (entry.dateAdded) {
      dateEl.textContent = 'Added: ' + new Date(entry.dateAdded).toLocaleDateString();
    } else {
      dateEl.textContent = '';
    }

    repositionTooltip(x, y);
    tip.classList.add('blg-visible');
  }

  function repositionTooltip(x, y) {
    if (!tooltipEl) return;
    const offset = 14;
    const tipW = tooltipEl.offsetWidth || 280;
    const tipH = tooltipEl.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + offset;
    let top = y + offset;
    if (left + tipW > vw - 10) left = x - tipW - offset;
    if (top + tipH > vh - 10) top = y - tipH - offset;

    tooltipEl.style.left = Math.max(8, left) + 'px';
    tooltipEl.style.top = Math.max(8, top) + 'px';
  }

  function hideTooltip() {
    tooltipTimeout = setTimeout(() => {
      if (tooltipEl) tooltipEl.classList.remove('blg-visible');
    }, 100);
  }

  // ── Add-entry Dialog ───────────────────────────────────────────────────────

  function showAddDialog(term, sourceUrl, sourceTitle) {
    // Remove any existing dialog
    removeDialog();

    const overlay = document.createElement('div');
    overlay.id = 'blg-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) removeDialog();
    });

    const dialog = document.createElement('div');
    dialog.id = 'blg-dialog';
    dialog.innerHTML = `
      <h2>🛡️ Add to Blacklist</h2>
      <div class="blg-field">
        <label for="blg-term">Term / Name</label>
        <input id="blg-term" type="text" placeholder="e.g. Acme Corporation" autocomplete="off">
      </div>
      <div class="blg-field">
        <label for="blg-reason">Reason <span style="font-weight:400;text-transform:none;color:#a8a29e">(why are you blacklisting this?)</span></label>
        <textarea id="blg-reason" placeholder="e.g. Sold defective products and refused a refund in 2024"></textarea>
      </div>
      <div class="blg-field">
        <label for="blg-category">Category (optional)</label>
        <select id="blg-category">
          <option value="other">Other / Unknown</option>
          <option value="person">Person</option>
          <option value="company">Company / Organisation</option>
          <option value="product">Product / Brand</option>
          <option value="author">Author / Journalist</option>
          <option value="website">Website / Publisher</option>
        </select>
      </div>
      <div id="blg-dialog-success">✓ Saved!</div>
      <div class="blg-dialog-footer">
        <button class="blg-btn blg-btn-secondary" id="blg-cancel-btn">Cancel</button>
        <button class="blg-btn blg-btn-primary" id="blg-save-btn">Save to Blacklist</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const termInput = dialog.querySelector('#blg-term');
    termInput.value = term || '';

    const saveBtn = dialog.querySelector('#blg-save-btn');
    const cancelBtn = dialog.querySelector('#blg-cancel-btn');
    const successEl = dialog.querySelector('#blg-dialog-success');

    cancelBtn.addEventListener('click', removeDialog);

    saveBtn.addEventListener('click', async () => {
      const termVal = termInput.value.trim();
      if (!termVal) {
        termInput.style.borderColor = '#ef4444';
        termInput.focus();
        return;
      }

      const newEntry = {
        id: Date.now().toString(),
        term: termVal,
        reason: dialog.querySelector('#blg-reason').value.trim(),
        category: dialog.querySelector('#blg-category').value,
        sourceUrl: sourceUrl || window.location.href,
        sourceTitle: sourceTitle || document.title,
        dateAdded: new Date().toISOString(),
        enabled: true
      };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      const current = await loadEntries();
      current.push(newEntry);
      await saveEntries(current);

      // Update local state and re-scan
      entries = current;
      buildMatcher(entries);
      runFullScan();

      successEl.style.display = 'block';
      setTimeout(removeDialog, 1200);
    });

    // Close on Escape key
    const escHandler = (e) => { if (e.key === 'Escape') removeDialog(); };
    document.addEventListener('keydown', escHandler, { once: true });

    termInput.focus();
    termInput.select();
  }

  function removeDialog() {
    const existing = document.getElementById('blg-overlay');
    if (existing) existing.remove();
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Message listener (from background.js) ─────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'showAddDialog') {
      showAddDialog(message.term, message.sourceUrl, message.sourceTitle);
    }
  });

  // Handle "View my list" button click — background.js will open the options page
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'openOptions') {
      chrome.runtime.openOptionsPage();
    }
  });

  // Re-scan if the user updates their list while this tab is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.entries) {
      entries = changes.entries.newValue || [];
      buildMatcher(entries);
      runFullScan();
    }
  });

  // ── Initialisation ─────────────────────────────────────────────────────────

  async function init() {
    entries = await loadEntries();
    if (entries.length === 0) return; // nothing to do — skip all setup

    buildMatcher(entries);
    runFullScan();
    setupMutationObserver();
  }

  // Run only once the page body is available
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
}
