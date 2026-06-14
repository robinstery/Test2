'use strict';

// Register the right-click context menu item when the extension is installed or updated.
// The %s placeholder is automatically replaced by Chrome with the selected text.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'blg-add',
    title: 'Add "%s" to Blacklist Memo',
    contexts: ['selection']
  });
});

// When the user clicks "Add to Blacklist Guardian" in the right-click menu,
// send the selected text to the content script running on that page.
// The content script will show the "Add entry" dialog pre-filled with the selected text.
// Handle requests from content scripts (e.g. the banner's "View my list" button)
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'blg-add') return;
  const selectedText = (info.selectionText || '').trim();
  if (!selectedText || !tab?.id) return;

  chrome.tabs.sendMessage(tab.id, {
    action: 'showAddDialog',
    term: selectedText,
    sourceUrl: tab.url || '',
    sourceTitle: tab.title || ''
  }).catch(() => {
    // Content script may not be ready on restricted pages (chrome://, file://, etc.)
    // Silently ignore — the user will see no dialog, which is acceptable.
  });
});
