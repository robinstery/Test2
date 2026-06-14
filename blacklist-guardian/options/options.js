'use strict';

// ── Storage ──────────────────────────────────────────────────────────────────

function getEntries() {
  return new Promise(resolve =>
    chrome.storage.local.get(['entries'], r => resolve(r.entries || []))
  );
}

function setEntries(entries) {
  return new Promise(resolve => chrome.storage.local.set({ entries }, resolve));
}

// ── State ────────────────────────────────────────────────────────────────────

let allEntries = [];
let sortKey    = 'dateAdded';
let sortDir    = 'desc'; // 'asc' or 'desc'

// ── Utility ──────────────────────────────────────────────────────────────────

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return '—'; }
}

const CAT_LABELS = {
  person: 'Person', company: 'Company', product: 'Product',
  author: 'Author', website: 'Website', other: 'Other'
};

function catLabel(cat) { return CAT_LABELS[cat] || 'Other'; }

// ── Render table ─────────────────────────────────────────────────────────────

function getFilteredSorted() {
  const q          = document.getElementById('search').value.trim().toLowerCase();
  const filterCat  = document.getElementById('filter-category').value;

  let list = allEntries.filter(e => {
    if (filterCat && e.category !== filterCat) return false;
    if (!q) return true;
    return (
      (e.term        || '').toLowerCase().includes(q) ||
      (e.reason      || '').toLowerCase().includes(q) ||
      (e.sourceTitle || '').toLowerCase().includes(q) ||
      (e.category    || '').toLowerCase().includes(q)
    );
  });

  list.sort((a, b) => {
    const va = (a[sortKey] || '').toLowerCase();
    const vb = (b[sortKey] || '').toLowerCase();
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  return list;
}

function renderTable() {
  const list  = getFilteredSorted();
  const tbody = document.getElementById('entries-tbody');

  document.getElementById('entry-count').textContent =
    allEntries.length > 0 ? `${allEntries.length} entries` : '';

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr id="empty-row">
        <td colspan="6" class="empty-cell">
          ${allEntries.length === 0
            ? 'Your blacklist is empty. Add entries using the right-click menu on any webpage, or via the extension popup.'
            : 'No entries match your search.'}
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = list.map(e => {
    const disabled = e.enabled === false;
    const catClass = `cat-${e.category || 'other'}`;
    return `
      <tr data-id="${esc(e.id)}" class="${disabled ? 'disabled-row' : ''}">
        <td class="term-cell">${esc(e.term)}</td>
        <td><span class="cat-badge ${catClass}">${esc(catLabel(e.category))}</span></td>
        <td class="reason-cell">${esc(e.reason) || '<span style="color:#a8a29e">—</span>'}</td>
        <td class="source-cell">
          ${e.sourceUrl
            ? `<a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener" class="source-link" title="${esc(e.sourceUrl)}">${esc(e.sourceTitle || e.sourceUrl)}</a>`
            : '<span style="color:#a8a29e">Added manually</span>'}
        </td>
        <td class="date-cell">${formatDate(e.dateAdded)}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn edit-btn"   data-id="${esc(e.id)}">Edit</button>
            <button class="action-btn toggle-btn" data-id="${esc(e.id)}">${disabled ? 'Enable' : 'Disable'}</button>
            <button class="action-btn delete-btn" data-id="${esc(e.id)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ── Sort headers ─────────────────────────────────────────────────────────────

document.querySelectorAll('thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
    // Update header classes
    document.querySelectorAll('thead th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderTable();
  });
});

// ── Search & filter ───────────────────────────────────────────────────────────

document.getElementById('search').addEventListener('input', renderTable);
document.getElementById('filter-category').addEventListener('change', renderTable);

// ── Table action button clicks (delegated) ────────────────────────────────────

document.getElementById('entries-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.classList.contains('edit-btn'))   { openEditModal(id); return; }
  if (btn.classList.contains('delete-btn')) { openDeleteModal(id); return; }

  if (btn.classList.contains('toggle-btn')) {
    const idx = allEntries.findIndex(x => x.id === id);
    if (idx === -1) return;
    allEntries[idx].enabled = allEntries[idx].enabled === false ? true : false;
    await setEntries(allEntries);
    renderTable();
  }
});

// ── Edit modal ────────────────────────────────────────────────────────────────

let editingId = null;

function openEditModal(id) {
  const entry = allEntries.find(e => e.id === id);
  if (!entry) return;

  editingId = id;
  document.getElementById('edit-term').value         = entry.term || '';
  document.getElementById('edit-reason').value       = entry.reason || '';
  document.getElementById('edit-category').value     = entry.category || 'other';
  document.getElementById('edit-source-title').value = entry.sourceTitle || '';
  document.getElementById('edit-source-url').value   = entry.sourceUrl || '';

  const overlay = document.getElementById('edit-overlay');
  overlay.hidden = false;
  document.getElementById('edit-term').focus();
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-overlay').hidden = true;
  editingId = null;
});

document.getElementById('edit-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('edit-overlay')) {
    document.getElementById('edit-overlay').hidden = true;
    editingId = null;
  }
});

document.getElementById('edit-save').addEventListener('click', async () => {
  if (!editingId) return;
  const idx = allEntries.findIndex(e => e.id === editingId);
  if (idx === -1) return;

  const term = document.getElementById('edit-term').value.trim();
  if (!term) {
    document.getElementById('edit-term').focus();
    return;
  }

  allEntries[idx] = {
    ...allEntries[idx],
    term,
    reason:      document.getElementById('edit-reason').value.trim(),
    category:    document.getElementById('edit-category').value,
    sourceTitle: document.getElementById('edit-source-title').value.trim(),
    sourceUrl:   document.getElementById('edit-source-url').value.trim()
  };

  await setEntries(allEntries);
  document.getElementById('edit-overlay').hidden = true;
  editingId = null;
  renderTable();
});

// ── Delete modal ──────────────────────────────────────────────────────────────

let deletingId = null;

function openDeleteModal(id) {
  const entry = allEntries.find(e => e.id === id);
  if (!entry) return;

  deletingId = id;
  document.getElementById('delete-confirm-text').textContent =
    `Are you sure you want to permanently delete "${entry.term}" from your blacklist?`;
  document.getElementById('delete-overlay').hidden = false;
}

document.getElementById('delete-cancel').addEventListener('click', () => {
  document.getElementById('delete-overlay').hidden = true;
  deletingId = null;
});

document.getElementById('delete-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('delete-overlay')) {
    document.getElementById('delete-overlay').hidden = true;
    deletingId = null;
  }
});

document.getElementById('delete-confirm').addEventListener('click', async () => {
  if (!deletingId) return;
  allEntries = allEntries.filter(e => e.id !== deletingId);
  await setEntries(allEntries);
  document.getElementById('delete-overlay').hidden = true;
  deletingId = null;
  renderTable();
});

// ── Export ────────────────────────────────────────────────────────────────────

document.getElementById('export-btn').addEventListener('click', () => {
  const json = JSON.stringify(allEntries, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `blacklist-guardian-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Import ────────────────────────────────────────────────────────────────────

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text     = await file.text();
    const imported = JSON.parse(text);

    if (!Array.isArray(imported)) throw new Error('File does not contain a list of entries.');

    // Merge: skip entries whose term already exists (case-insensitive)
    const existingTerms = new Set(allEntries.map(x => x.term.toLowerCase()));
    const newEntries = imported.filter(e =>
      e && typeof e.term === 'string' && !existingTerms.has(e.term.toLowerCase())
    );

    allEntries = [...allEntries, ...newEntries];
    await setEntries(allEntries);

    const notice = document.getElementById('import-notice');
    notice.textContent = newEntries.length > 0
      ? `✓ Imported ${newEntries.length} new entries (${imported.length - newEntries.length} already existed and were skipped).`
      : `All ${imported.length} entries in this file already exist in your list — nothing new was added.`;
    notice.hidden = false;
    setTimeout(() => { notice.hidden = true; }, 5000);

    renderTable();
  } catch (err) {
    alert('Could not import file: ' + err.message);
  }

  // Reset the file input so the same file can be re-imported if needed
  e.target.value = '';
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('edit-overlay').hidden   = true;
    document.getElementById('delete-overlay').hidden = true;
    editingId   = null;
    deletingId  = null;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

getEntries().then(entries => {
  allEntries = entries;
  renderTable();
});

// Keep the page in sync if the list changes in another tab/popup
chrome.storage.onChanged.addListener((changes) => {
  if (changes.entries) {
    allEntries = changes.entries.newValue || [];
    renderTable();
  }
});
