// Service Worker — runs once on install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // First install: enable RTL fix by default
    chrome.storage.local.set({ isEnabled: true });
  }
  // On update, do NOT overwrite the user's saved preference
});
