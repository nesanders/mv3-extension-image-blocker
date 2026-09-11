// Secondary controls popup. The primary interaction (one-tap global toggle)
// lives on the toolbar icon itself via action.onClicked in background.js —
// this popup (and the right-click context menu) is for the less-frequent
// per-site toggle and a manual "load everything on this page" action,
// reachable via right-click rather than being the only path to either
// toggle.
const DEFAULTS = {
  globalBlockingEnabled: true,
  siteAllowlist: [],
  sizeThresholdEnabled: false,
  sizeThresholdKB: 50
};

const siteEl = document.getElementById('site');
const siteToggleEl = document.getElementById('site-toggle');
const globalToggleEl = document.getElementById('global-toggle');
const loadAllEl = document.getElementById('load-all');
const openOptionsEl = document.getElementById('open-options');

let activeTab = null;
let hostname = null;

function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  hostname = tab && tab.url ? extractHostname(tab.url) : null;
  siteEl.textContent = hostname || 'this site';

  const settings = await chrome.storage.local.get(DEFAULTS);
  globalToggleEl.checked = settings.globalBlockingEnabled;
  const isAllowlisted = hostname ? settings.siteAllowlist.includes(hostname) : false;
  siteToggleEl.checked = !isAllowlisted; // checked = blocking is ON for this site
  siteToggleEl.disabled = !hostname;
}

siteToggleEl.addEventListener('change', async () => {
  if (!hostname) return;
  const { siteAllowlist } = await chrome.storage.local.get({ siteAllowlist: [] });
  const wantBlocked = siteToggleEl.checked;
  const isAllowlisted = siteAllowlist.includes(hostname);
  if (wantBlocked && isAllowlisted) {
    await chrome.storage.local.set({ siteAllowlist: siteAllowlist.filter((d) => d !== hostname) });
  } else if (!wantBlocked && !isAllowlisted) {
    await chrome.storage.local.set({ siteAllowlist: [...siteAllowlist, hostname] });
  }
});

globalToggleEl.addEventListener('change', () => {
  chrome.storage.local.set({ globalBlockingEnabled: globalToggleEl.checked });
});

loadAllEl.addEventListener('click', () => {
  if (activeTab && activeTab.id) {
    chrome.tabs.sendMessage(activeTab.id, { type: 'reloadPlaceholders' }).catch(() => {});
  }
});

openOptionsEl.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
