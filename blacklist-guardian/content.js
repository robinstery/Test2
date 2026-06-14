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
  let entryMap = new Map();     // lowercase primary term → entry[]
  let termToPrimary = new Map(); // any lowercase term/alias → lowercase primary term
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
      chrome.storage.sync.get(['entries'], (result) => {
        resolve(result.entries || []);
      });
    });
  }

  function saveEntries(updatedEntries) {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ entries: updatedEntries }, resolve);
    });
  }

  // ── Regex / lookup builder ─────────────────────────────────────────────────

  function parseAliases(aliasStr) {
    if (!aliasStr) return [];
    return aliasStr.split(';').map(a => a.trim()).filter(Boolean);
  }

  function buildMatcher(allEntries) {
    const active = allEntries.filter(e => e.enabled !== false);
    entryMap = new Map();
    termToPrimary = new Map();
    if (active.length === 0) {
      termRegex = null;
      return;
    }

    // Group entries by primary term; map every alias back to that primary key
    active.forEach(e => {
      const primaryKey = e.term.toLowerCase();
      if (!entryMap.has(primaryKey)) entryMap.set(primaryKey, []);
      entryMap.get(primaryKey).push(e);
      termToPrimary.set(primaryKey, primaryKey);
      parseAliases(e.aliases).forEach(alias => {
        termToPrimary.set(alias.toLowerCase(), primaryKey);
      });
    });

    // Sort longer terms first so "Acme Corporation" matches before "Acme"
    const escaped = [...termToPrimary.keys()]
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
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

    const matched = new Map(); // primaryKey → { entryList, matchedAs }

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
          // Skip nodes inside any of our own injected elements (the closest() check
          // also handles text inside the <sup> badge nested inside a <mark>)
          if (parent.closest && parent.closest('.blg-highlight, #blg-banner, #blg-overlay, #blg-tooltip')) {
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
        const key = matchedText.toLowerCase();
        const primaryKey = termToPrimary.get(key);
        if (!primaryKey) continue;
        const entryList = entryMap.get(primaryKey);
        if (!entryList || entryList.length === 0) continue;

        if (!matched.has(primaryKey)) matched.set(primaryKey, { entryList, matchedAs: matchedText });

        // Text before the match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        // The highlighted element
        const mark = document.createElement('mark');
        mark.className = 'blg-highlight';
        mark.dataset.term = primaryKey;
        mark.dataset.matchedAs = matchedText;
        mark.appendChild(document.createTextNode(matchedText));
        // Show entry count as a superscript badge when the term has multiple reasons
        if (entryList.length > 1) {
          const badge = document.createElement('sup');
          badge.className = 'blg-count-badge';
          badge.textContent = entryList.length;
          mark.appendChild(badge);
        }
        mark.addEventListener('mouseenter', (e) => showTooltip(entryList, matchedText, e.clientX, e.clientY));
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
    if (matched.size > 0) showBanner([...matched.values()]);

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
          // Re-collect all matched entry lists to update the banner
          const allMatched = new Map();
          document.querySelectorAll('mark.blg-highlight').forEach(mark => {
            const primaryKey = mark.dataset.term;
            const matchedAs = mark.dataset.matchedAs || mark.childNodes[0]?.textContent || '';
            if (primaryKey && entryMap.has(primaryKey) && !allMatched.has(primaryKey)) {
              allMatched.set(primaryKey, { entryList: entryMap.get(primaryKey), matchedAs });
            }
          });
          removeBanner();
          if (allMatched.size > 0) showBanner([...allMatched.values()]);
        }

        mutationObserver.observe(document.body, { childList: true, subtree: true });
      }, 500);
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Banner ─────────────────────────────────────────────────────────────────

  function showBanner(matchedItems) {
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

    // Show up to 3 terms; if more, add "and N more"
    const displayItems = matchedItems.slice(0, 3);
    const extra = matchedItems.length - displayItems.length;

    termsEl.appendChild(document.createTextNode('Heads up! This page mentions '));

    displayItems.forEach((item, i) => {
      const { entryList, matchedAs } = item;
      const primaryTerm = entryList[0].term;
      const isAlias = matchedAs.toLowerCase() !== primaryTerm.toLowerCase();

      const em = document.createElement('em');
      em.appendChild(document.createTextNode(primaryTerm));
      if (isAlias) {
        const aliasNote = document.createElement('span');
        aliasNote.className = 'blg-banner-alias';
        aliasNote.textContent = ` (matched as: ${matchedAs})`;
        em.appendChild(aliasNote);
      }
      if (entryList.length > 1) {
        const badge = document.createElement('sup');
        badge.className = 'blg-count-badge';
        badge.textContent = entryList.length;
        em.appendChild(badge);
      }
      em.addEventListener('mouseenter', (e) => showTooltip(entryList, matchedAs, e.clientX, e.clientY));
      em.addEventListener('mousemove', (e) => repositionTooltip(e.clientX, e.clientY));
      em.addEventListener('mouseleave', hideTooltip);
      termsEl.appendChild(em);
      if (i < displayItems.length - 1) {
        termsEl.appendChild(document.createTextNode(', '));
      }
    });

    if (extra > 0) {
      termsEl.appendChild(document.createTextNode(` and ${extra} more`));
    }

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
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function showTooltip(entryList, matchedAs, x, y) {
    clearTimeout(tooltipTimeout);
    const tip = ensureTooltip();
    tip.innerHTML = '';

    const termEl = document.createElement('div');
    termEl.id = 'blg-tooltip-term';
    const primaryTerm = entryList[0].term;
    const isAlias = matchedAs.toLowerCase() !== primaryTerm.toLowerCase();
    termEl.textContent = isAlias ? `${primaryTerm} (matched as: ${matchedAs})` : primaryTerm;
    tip.appendChild(termEl);

    entryList.forEach((entry, i) => {
      if (entryList.length > 1) {
        const divider = document.createElement('div');
        divider.className = 'blg-tooltip-divider';
        divider.textContent = `Reason ${i + 1}`;
        tip.appendChild(divider);
      }

      const reasonEl = document.createElement('div');
      reasonEl.className = 'blg-tooltip-reason';
      reasonEl.textContent = entry.reason || 'No reason recorded.';
      tip.appendChild(reasonEl);

      const sourceEl = document.createElement('div');
      sourceEl.className = 'blg-tooltip-source';
      sourceEl.textContent = (entry.sourceTitle || entry.sourceUrl)
        ? 'Source: ' + (entry.sourceTitle || entry.sourceUrl)
        : 'Added manually';
      tip.appendChild(sourceEl);

      if (entry.dateAdded) {
        const dateEl = document.createElement('div');
        dateEl.className = 'blg-tooltip-date';
        dateEl.textContent = 'Added: ' + new Date(entry.dateAdded).toLocaleDateString();
        tip.appendChild(dateEl);
      }
    });

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
        <label for="blg-aliases">Known aliases <span style="font-weight:400;text-transform:none;color:#a8a29e">(separate with ;)</span></label>
        <input id="blg-aliases" type="text" placeholder="e.g. J. Smith; J.R. Smith; Smith, J." autocomplete="off">
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
        aliases: dialog.querySelector('#blg-aliases').value.trim(),
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
