'use strict';

const termInput      = document.getElementById('term');
const reasonInput    = document.getElementById('reason');
const categorySel    = document.getElementById('category');
const saveBtn        = document.getElementById('save-btn');
const successMsg     = document.getElementById('save-success');
const errorMsg       = document.getElementById('save-error');
const recentList     = document.getElementById('recent-list');
const totalCount     = document.getElementById('total-count');
const openOptions    = document.getElementById('open-options');
const sourceCheckEl  = document.getElementById('include-source');
const sourcePreviewEl = document.getElementById('source-preview');

let currentTab = null;

// Load the current tab so we can show and optionally save its URL/title
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    currentTab = tab;
    sourcePreviewEl.textContent = tab.title || tab.url;
  } else {
    sourceCheckEl.checked  = false;
    sourceCheckEl.disabled = true;
    sourcePreviewEl.textContent = 'No page available';
    sourcePreviewEl.style.opacity = '0.4';
  }
});

sourceCheckEl.addEventListener('change', () => {
  sourcePreviewEl.style.opacity        = sourceCheckEl.checked ? '1' : '0.35';
  sourcePreviewEl.style.textDecoration = sourceCheckEl.checked ? '' : 'line-through';
});

// ── Storage helpers ────────────────────────────────────────────────────────

function getEntries() {
  return new Promise(resolve =>
    chrome.storage.sync.get(['entries'], r => resolve(r.entries || []))
  );
}

function setEntries(entries) {
  return new Promise(resolve => chrome.storage.sync.set({ entries }, resolve));
}

// ── Render recent entries ──────────────────────────────────────────────────

function renderRecent(entries) {
  totalCount.textContent = entries.length > 0 ? entries.length : '';

  if (entries.length === 0) {
    recentList.innerHTML =
      '<li class="empty-msg">Your blacklist is empty.<br>Add your first entry above.</li>';
    return;
  }

  // Show the 5 most recently added entries
  const recent = [...entries]
    .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''))
    .slice(0, 5);

  recentList.innerHTML = recent.map(e => {
    const catClass = `cat-${e.category || 'other'}`;
    return `
      <li class="recent-item">
        <span class="recent-term" title="${escHtml(e.term)}">${escHtml(e.term)}</span>
        <span class="recent-category ${catClass}">${escHtml(categoryLabel(e.category))}</span>
      </li>
    `;
  }).join('');
}

function categoryLabel(cat) {
  const labels = {
    person: 'Person',
    company: 'Company',
    product: 'Product',
    author: 'Author',
    website: 'Website',
    other: 'Other'
  };
  return labels[cat] || 'Other';
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Save a new entry ───────────────────────────────────────────────────────

async function handleSave() {
  const term = termInput.value.trim();
  errorMsg.hidden = true;
  successMsg.hidden = true;

  if (!term) {
    errorMsg.hidden = false;
    termInput.focus();
    return;
  }

  const includeSource = sourceCheckEl.checked && currentTab;
  const newEntry = {
    id: Date.now().toString(),
    term,
    aliases:     document.getElementById('aliases').value.trim(),
    reason:      reasonInput.value.trim(),
    category:    categorySel.value,
    sourceUrl:   includeSource ? (currentTab.url   || '') : '',
    sourceTitle: includeSource ? (currentTab.title || '') : '',
    dateAdded:   new Date().toISOString(),
    enabled:     true
  };

  saveBtn.disabled = true;

  const entries = await getEntries();
  entries.push(newEntry);
  await setEntries(entries);

  // Reset form
  termInput.value = '';
  document.getElementById('aliases').value = '';
  reasonInput.value = '';
  categorySel.value = 'other';
  saveBtn.disabled = false;

  successMsg.hidden = false;
  setTimeout(() => { successMsg.hidden = true; }, 2500);

  renderRecent(entries);
  termInput.focus();
}

// ── Init ───────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', handleSave);
termInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSave(); });
openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

getEntries().then(renderRecent);
