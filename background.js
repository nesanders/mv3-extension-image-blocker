// Service worker: single source of truth for extension state, and the only
// place that talks to declarativeNetRequest. Content scripts and the
// popup/options pages never touch DNR directly - they read/write
// chrome.storage.local, and this file reconciles DNR rules to match
// whenever storage changes. That keeps "make images load" to one code
// path regardless of whether it was triggered by a single click, the
// per-site toggle, or the global toggle.
importScripts('lib/domain.js', 'lib/rules.js', 'lib/decisions.js');

const BLOCK_RULESET_ID = 'block-images';

const DEFAULT_SETTINGS = {
  globalBlockingEnabled: true,
  siteAllowlist: [],
  sizeThresholdEnabled: false,
  sizeThresholdKB: 50
};

const SESSION_RULE_TIMEOUT_MS = 10000;
// In-memory only: best-effort cleanup timers for session (click-to-load)
// rules. If the service worker is killed before a timer fires, the rule
// simply outlives its 10s target slightly - harmless, and cleaned up by
// clearStaleSessionRules() on the next worker startup.
const pendingSessionTimers = new Map();

// --- Diagnostics (unpacked/dev-mode only) ---------------------------------
// onRuleMatchedDebug only fires for unpacked (developer-mode) extensions,
// which matches how this extension is loaded (chrome://extensions or
// vivaldi://extensions -> Load unpacked). Open this service worker's
// console (chrome://extensions -> this extension -> "service worker" link
// under "Inspect views") and reload a page: every request our block rule
// matches gets logged here. If a site's images visibly load anyway, check
// this log first - if the image's request never appears here at all, DNR
// never saw it as resourceType "image" in the first place (a common cause:
// a site's own JS fetches the image via fetch()/XHR - classified as
// "xmlhttprequest", not "image" - and only assigns it to <img src> once
// downloaded, e.g. for a fade-in effect; DNR can't distinguish that from
// any other XHR call, so it can't be blocked without blocking way more
// than images - see README's "Known limitations").
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    console.log('[CTLI] rule matched:', info.rule, info.request.type, info.request.url);
  });
}

function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  await chrome.storage.local.set(merged);
  await applyGlobalRulesetState(merged.globalBlockingEnabled);
  await reconcileSiteRules(merged.siteAllowlist, []);
  setUpContextMenus();
  await updateAllBadges();
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await applyGlobalRulesetState(settings.globalBlockingEnabled);
  await reconcileSiteRules(settings.siteAllowlist, settings.siteAllowlist);
  await clearStaleSessionRules();
  await updateAllBadges();
});

function setUpContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ctli-open-popup',
      title: 'Open quick panel',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-toggle-site',
      title: 'Toggle blocking for this site',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-load-all',
      title: 'Load all images on this page',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-open-options',
      title: 'Open options',
      contexts: ['action']
    });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) updateSiteMenuItem(tab);
    });
  });
}

// The context-menu item's label reflects the active tab's current site
// state ("Block images on x.com" vs. "Allow images on x.com"), since
// contextMenus items have no per-click "about to show" hook in MV3 - we
// keep it current by refreshing on every tab switch/navigation and every
// relevant storage change instead (see tabs.onActivated/onUpdated below
// and the storage.onChanged listener).
async function updateSiteMenuItem(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    chrome.contextMenus
      .update('ctli-toggle-site', { title: 'Toggle blocking for this site', enabled: false })
      .catch(() => {});
    return;
  }
  const hostname = extractHostname(tab.url);
  if (!hostname) return;
  const settings = await getSettings();
  const isAllowed = isAllowlisted(hostname, settings.siteAllowlist);
  const title = isAllowed ? `Block images on ${hostname}` : `Allow images on ${hostname}`;
  chrome.contextMenus.update('ctli-toggle-site', { title, enabled: true }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ctli-open-popup') {
    // No default_popup is set in the manifest, so a primary click on the
    // toolbar icon fires action.onClicked (the instant global toggle)
    // instead of opening a popup - that's required for the one-tap
    // interaction. To still offer popup.html's secondary controls from
    // this context-menu item, set it as the popup just long enough to
    // open it, then clear it again so future icon clicks go back to
    // onClicked. chrome.action.openPopup() requires Chrome 127+ and isn't
    // available on every platform (notably some Android builds) - fall
    // back to the options page, which surfaces the same controls, when
    // it's missing.
    if (chrome.action.openPopup) {
      chrome.action
        .setPopup({ popup: 'popup.html' })
        .then(() => chrome.action.openPopup())
        .catch(() => chrome.runtime.openOptionsPage())
        .finally(() => chrome.action.setPopup({ popup: '' }).catch(() => {}));
    } else {
      chrome.runtime.openOptionsPage();
    }
  } else if (info.menuItemId === 'ctli-toggle-site') {
    await toggleSiteForTab(tab);
  } else if (info.menuItemId === 'ctli-load-all') {
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'reloadPlaceholders' }).catch(() => {});
    }
  } else if (info.menuItemId === 'ctli-open-options') {
    chrome.runtime.openOptionsPage();
  }
});

// --- DNR reconciliation -----------------------------------------------

async function applyGlobalRulesetState(enabled) {
  if (enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [BLOCK_RULESET_ID]
    });
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [BLOCK_RULESET_ID]
    });
  }
}

async function reconcileSiteRules(newList, oldList) {
  newList = newList || [];
  oldList = oldList || [];
  const added = newList.filter((d) => !oldList.includes(d));
  const removed = oldList.filter((d) => !newList.includes(d));

  const addRules = added.map((domain) => buildSiteAllowRule(siteRuleId(domain), domain));
  const removeRuleIds = removed.map((domain) => siteRuleId(domain));

  if (addRules.length || removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds });
  }
}

async function clearStaleSessionRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ids = existing.map((r) => r.id);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  // Only reload already-open tabs' placeholders when blocking genuinely
  // became *more permissive* than it was a moment ago - never on the
  // initial defaults being written at install, and never for an unrelated
  // settings change (e.g. the size threshold), which would otherwise
  // force-load every placeholder on every open tab for no reason.
  let becameMorePermissive = false;

  if (changes.siteAllowlist) {
    const oldList = changes.siteAllowlist.oldValue || [];
    const newList = changes.siteAllowlist.newValue || [];
    await reconcileSiteRules(newList, oldList);
    if (newList.some((d) => !oldList.includes(d))) becameMorePermissive = true;
  }
  if (changes.globalBlockingEnabled) {
    await applyGlobalRulesetState(changes.globalBlockingEnabled.newValue);
    if (changes.globalBlockingEnabled.oldValue === true && changes.globalBlockingEnabled.newValue === false) {
      becameMorePermissive = true;
    }
  }
  if (changes.siteAllowlist || changes.globalBlockingEnabled) {
    await updateAllBadges();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) updateSiteMenuItem(activeTab);
  }
  if (becameMorePermissive) {
    await broadcastReload();
  }
});

async function broadcastReload() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'reloadPlaceholders' }).catch(() => {});
  }
}

// --- Badge ---------------------------------------------------------------

async function isBlockingActiveForUrl(url) {
  const settings = await getSettings();
  if (!settings.globalBlockingEnabled) return false;
  const hostname = extractHostname(url);
  if (!hostname) return false;
  return !isAllowlisted(hostname, settings.siteAllowlist);
}

async function updateBadgeForTab(tabId, url) {
  if (!tabId || !url || !/^https?:/.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  const active = await isBlockingActiveForUrl(url);
  if (active) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ tabId, text: 'OFF' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#7a7a7a' }).catch(() => {});
  }
}

async function updateAllBadges() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) updateBadgeForTab(tab.id, tab.url);
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    updateBadgeForTab(tab.id, tab.url);
    updateSiteMenuItem(tab);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    updateBadgeForTab(tabId, tab.url);
    if (tab.active) updateSiteMenuItem(tab);
  }
});

// --- Per-site / global toggles -------------------------------------------

async function toggleSiteForTab(tab) {
  if (!tab || !tab.url) return;
  const hostname = extractHostname(tab.url);
  if (!hostname) return;

  const settings = await getSettings();
  const list = settings.siteAllowlist.slice();
  const idx = list.indexOf(hostname);
  if (idx === -1) {
    list.push(hostname);
  } else {
    list.splice(idx, 1);
  }
  await chrome.storage.local.set({ siteAllowlist: list });
}

async function toggleGlobal() {
  const settings = await getSettings();
  await chrome.storage.local.set({ globalBlockingEnabled: !settings.globalBlockingEnabled });
}

chrome.action.onClicked.addListener(() => {
  toggleGlobal();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-site-blocking') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    toggleSiteForTab(tab);
  }
});

// --- Messages from content script / popup / options -----------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'loadImage':
      return loadImage(message.url, sender.tab && sender.tab.id);
    case 'imageLoaded':
      return imageLoaded(message.url, sender.tab && sender.tab.id);
    case 'checkSize':
      return { sizeBytes: await checkImageSize(message.url) };
    case 'getState':
      return getStateForMessage(sender);
    case 'toggleSite':
      await toggleSiteForTab(sender.tab || message.tab);
      return { ok: true };
    case 'toggleGlobal':
      await toggleGlobal();
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

async function getStateForMessage(sender) {
  const settings = await getSettings();
  const url = sender.tab && sender.tab.url;
  const hostname = url ? extractHostname(url) : null;
  const siteAllowed = hostname ? isAllowlisted(hostname, settings.siteAllowlist) : false;
  return {
    ...settings,
    hostname,
    siteAllowed,
    blockingActive: settings.globalBlockingEnabled && !siteAllowed
  };
}

// --- Click-to-load single image (session-scoped allow rule) --------------

async function loadImage(url, tabId) {
  if (!url || !tabId) return { ok: false, error: 'missing url or tabId' };

  const id = sessionRuleId(tabId, url);
  const rule = buildTabImageAllowRule(id, url, tabId);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [rule]
  });

  if (pendingSessionTimers.has(id)) {
    clearTimeout(pendingSessionTimers.get(id));
  }
  const timer = setTimeout(() => {
    chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [id] })
      .catch(() => {});
    pendingSessionTimers.delete(id);
  }, SESSION_RULE_TIMEOUT_MS);
  pendingSessionTimers.set(id, timer);

  return { ok: true };
}

async function imageLoaded(url, tabId) {
  if (!url || !tabId) return { ok: true };
  const id = sessionRuleId(tabId, url);
  if (pendingSessionTimers.has(id)) {
    clearTimeout(pendingSessionTimers.get(id));
    pendingSessionTimers.delete(id);
  }
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [id] })
    .catch(() => {});
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const idsForTab = existing
    .filter((r) => r.condition && Array.isArray(r.condition.tabIds) && r.condition.tabIds.includes(tabId))
    .map((r) => r.id);
  if (idsForTab.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: idsForTab });
  }
});

// --- Size-threshold check --------------------------------------------------

async function checkImageSize(url) {
  try {
    const headResp = await fetch(url, { method: 'HEAD' });
    const headLen = headResp.headers.get('content-length');
    if (headLen != null) return parseInt(headLen, 10);
  } catch (e) {
    // fall through to range GET
  }

  try {
    const rangeResp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const contentRange = rangeResp.headers.get('content-range');
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) return parseInt(match[1], 10);
    }
    const len = rangeResp.headers.get('content-length');
    if (len != null && rangeResp.status !== 206) {
      // Origin ignored the Range header and sent the whole thing.
      return parseInt(len, 10);
    }
  } catch (e) {
    // size genuinely unknown
  }

  return null;
}
