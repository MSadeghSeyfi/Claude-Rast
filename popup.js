'use strict';

const toggle = document.getElementById('toggle');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const reloadNotice = document.getElementById('reloadNotice');
const reloadBtn = document.getElementById('reloadBtn');

// ─── Render UI state based on isEnabled value ─────────────────────────────
function renderState(isEnabled) {
  toggle.checked = isEnabled;

  if (isEnabled) {
    statusBadge.className = 'status-badge on';
    statusText.textContent = 'فعال';
  } else {
    statusBadge.className = 'status-badge off';
    statusText.textContent = 'غیرفعال';
  }
}

// ─── Load stored state on popup open ─────────────────────────────────────
chrome.storage.local.get(['isEnabled'], ({ isEnabled }) => {
  // Default to true if not set yet (first install before background runs)
  renderState(isEnabled !== false);
});

// ─── Handle toggle change ─────────────────────────────────────────────────
toggle.addEventListener('change', () => {
  const isEnabled = toggle.checked;

  // Persist new state
  chrome.storage.local.set({ isEnabled });

  // Update UI
  renderState(isEnabled);

  // Notify the active claude.ai tab (live toggle without reload)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    const isClaudeTab = tab.url && tab.url.startsWith('https://claude.ai');

    if (isClaudeTab) {
      // Try sending a live toggle message to the content script
      chrome.tabs.sendMessage(tab.id, { type: 'RTL_TOGGLE', isEnabled }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not ready — show reload notice
          reloadNotice.classList.add('visible');
        } else {
          // Successfully toggled live — no reload needed
          reloadNotice.classList.remove('visible');
        }
      });
    } else {
      // Not on claude.ai — no notice needed
      reloadNotice.classList.remove('visible');
    }
  });
});

// ─── Reload button ────────────────────────────────────────────────────────
reloadBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab) {
      chrome.tabs.reload(tab.id);
      window.close(); // Close popup after triggering reload
    }
  });
});
