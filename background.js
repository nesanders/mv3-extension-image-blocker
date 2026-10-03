// Service worker: single source of truth for extension state, and the only
// place that talks to declarativeNetRequest. Content scripts and the
// popup/options pages never touch DNR directly - they read/write
// chrome.storage.local, and this file reconciles DNR rules to match
// whenever storage changes. That keeps "make it load" to one code path
// regardless of whether it was triggered by a single click, the per-site
// toggle, or the global toggle - and regardless of whether the blocked
// element is an image, a video, or audio. The static block rule
// (rules/block-media.json) covers resourceTypes "image" and "media" -
// DNR has no separate resourceType for video vs. audio, so "media" blocks
// both <video> and <audio> elements together.
importScripts('lib/domain.js', 'lib/rules.js', 'lib/decisions.js');

const BLOCK_RULESET_ID = 'block-media';

// Toolbar icon variants used to show *global* blocking state at a glance -
// distinct from the per-tab badge text, which reflects whether blocking is
// active for the current tab specifically (global AND site combined). This
// is set without a tabId, so it applies everywhere, not just one tab.
const ICON_ON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICON_OFF = {
  16: 'icons/icon16-off.png',
  32: 'icons/icon32-off.png',
  48: 'icons/icon48-off.png',
  128: 'icons/icon128-off.png'
};

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
// matches gets logged here. If a site's images/video visibly load anyway,
// check this log first - if the request never appears here at all, DNR
// never saw it as resourceType "image"/"media" in the first place (a
// common cause: a site's own JS fetches the bytes via fetch()/XHR -
// classified as "xmlhttprequest", not "image"/"media" - and only assigns
// them to <img src>/<video src> once downloaded, e.g. for a fade-in
// effect; DNR can't distinguish that from any other XHR call, so it can't
// be blocked without blocking way more than images/video - see README's
// "Known limitations").
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    console.log('[CTLI] rule matched:', info.rule, info.request.type, info.request.url);
  });
}

function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// --- DNR mutation serialization --------------------------------------------
// Several functions below read the currently-registered rules, compute a
// collision-free id against that snapshot, then write - a classic
// check-then-act sequence. The service worker is single-threaded, but
// `await`s let separate calls interleave (e.g. two placeholders for the
// same image reload concurrently and both call loadImage() for the same
// tab+url), so without serialization two interleaved calls can both read
// "no rule yet", both resolve to the same id, and the second write throws
// "Rule with id <n> does not have a unique ID" - the same crash a hash
// collision causes, just self-inflicted by concurrency instead. Routing
// every DNR-mutating call through one promise chain makes each one run
// to completion before the next starts, which removes the race without
// requiring every call site to reason about concurrency itself.
let dnrMutationQueue = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    const run = dnrMutationQueue.then(() => fn(...args));
    // Keep the chain alive even if this call rejects, so one failure
    // doesn't permanently wedge every later call behind a rejected link.
    dnrMutationQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  await chrome.storage.local.set(merged);
  await applyGlobalRulesetState();
  await reconcileSiteRules();
  setUpContextMenus();
  await updateAllBadges();
});

chrome.runtime.onStartup.addListener(async () => {
  await applyGlobalRulesetState();
  await reconcileSiteRules();
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
      id: 'ctli-toggle-global',
      type: 'checkbox',
      title: 'Block media globally',
      checked: true,
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-toggle-site',
      type: 'checkbox',
      title: 'Block media on this site',
      checked: true,
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-load-all',
      title: 'Load everything on this page',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ctli-open-options',
      title: 'Open options',
      contexts: ['action']
    });
    getSettings().then((settings) => updateGlobalMenuItem(settings.globalBlockingEnabled));
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) updateSiteMenuItem(tab);
    });
  });
}

// checkbox-type menu items show a checkmark reflecting `checked`, giving a
// real on/off indicator in the right-click menu (not just an action
// label). We always set `checked` explicitly from the real stored state
// rather than trusting Chrome's own optimistic toggle-on-click, so it
// can't drift out of sync with what's actually happening.
async function updateGlobalMenuItem(enabled) {
  chrome.contextMenus
    .update('ctli-toggle-global', { checked: !!enabled })
    .catch(() => {});
}

// The context-menu item's label and checked state reflect the active
// tab's current site ("Block media on x.com", checked when blocking is
// actually active there), since contextMenus items have no per-click
// "about to show" hook in MV3 - we keep it current by refreshing on every
// tab switch/navigation and every relevant storage change instead (see
// tabs.onActivated/onUpdated below and the storage.onChanged listener).
async function updateSiteMenuItem(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    chrome.contextMenus
      .update('ctli-toggle-site', { title: 'Block media on this site', enabled: false })
      .catch(() => {});
    return;
  }
  const hostname = extractHostname(tab.url);
  if (!hostname) return;
  const settings = await getSettings();
  const isAllowed = isAllowlisted(hostname, settings.siteAllowlist);
  chrome.contextMenus
    .update('ctli-toggle-site', {
      title: `Block media on ${hostname}`,
      checked: !isAllowed,
      enabled: true
    })
    .catch(() => {});
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
  } else if (info.menuItemId === 'ctli-toggle-global') {
    await toggleGlobal();
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

// Takes no arguments and re-reads the current setting from storage itself,
// rather than trusting a value a caller captured earlier - serialized()
// means an arbitrary number of other queued operations can run between
// "a caller decided this needs reconciling" and "this function actually
// runs," during which storage can change again. A value captured at call
// time would then be stale by the time it's actually used, silently
// reverting whatever changed in between (this was a real, reproducible
// bug: see reconcileSiteRulesImpl below for the concrete failure mode).
// Reading fresh at execution time instead means this always reconciles
// against the true current desired state, however long it waited in the
// queue.
async function applyGlobalRulesetStateImpl() {
  const { globalBlockingEnabled } = await getSettings();
  if (globalBlockingEnabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [BLOCK_RULESET_ID]
    });
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [BLOCK_RULESET_ID]
    });
  }
  await chrome.action.setIcon({ path: globalBlockingEnabled ? ICON_ON : ICON_OFF }).catch(() => {});
  await updateGlobalMenuItem(globalBlockingEnabled);
}
const applyGlobalRulesetState = serialized(applyGlobalRulesetStateImpl);

// Reconciles dynamic (persistent, site-allowlist) rules to match the
// *current* siteAllowlist setting (re-read from storage here, not passed
// in - see applyGlobalRulesetStateImpl's comment above for why), diffed
// against what Chrome actually has registered right now rather than
// against a caller-supplied "previous" list. Together this makes
// reconciliation idempotent and self-healing: safe to call after a
// browser restart, after an extension update where last run's rules are
// still sitting there, or after sitting in the serialized() queue behind
// other operations for an unknown amount of time.
//
// A real, reproducible bug this fixes: reconcileSiteRules used to take
// the desired list as a parameter. onInstalled calls it once directly
// with the list it read at startup; chrome.storage.local.set() in that
// same handler also fires storage.onChanged, whose listener calls it
// again with the list from the change event. Once calls started queuing
// behind each other (serialized()), onInstalled's own call - carrying a
// value captured before the handler even started - could end up
// executing *after* a legitimate concurrent change (e.g. the person
// editing the allowlist within the first instant of a fresh install).
// Reconciling against that stale snapshot then deleted the rule the
// newer change had just added, deterministically whenever the timing
// landed that way. Re-reading storage at execution time removes the
// stale value entirely - there's nothing left to go stale.
async function reconcileSiteRulesImpl() {
  const { siteAllowlist } = await getSettings();
  const desiredList = siteAllowlist || [];

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const usedIds = new Set(existing.map((r) => r.id));
  const domainToId = new Map();
  for (const r of existing) {
    const domain = r.condition && r.condition.requestDomains && r.condition.requestDomains[0];
    if (domain) domainToId.set(domain, r.id);
  }

  const added = desiredList.filter((d) => !domainToId.has(d));
  const removed = Array.from(domainToId.keys()).filter((d) => !desiredList.includes(d));
  if (!added.length && !removed.length) return;

  const removeRuleIds = removed.map((domain) => domainToId.get(domain));
  const freedIds = new Set(removeRuleIds);

  // siteRuleId() is a hash, not an allocator - two different domains can
  // land on the same id. Resolve against the registered-id set above
  // rather than trusting the hash blindly, or a collision throws "Rule
  // with id <n> does not have a unique ID" as an uncaught rejection and
  // silently drops this entire update (DNR applies updateDynamicRules
  // atomically).
  const addRules = added.map((domain) => {
    const id = resolveRuleId(siteRuleId(domain), usedIds, freedIds, SITE_RULE_ID_BASE, SITE_RULE_ID_RANGE);
    usedIds.add(id);
    return buildSiteAllowRule(id, domain);
  });

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds });
}
const reconcileSiteRules = serialized(reconcileSiteRulesImpl);

async function clearStaleSessionRulesImpl() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ids = existing.map((r) => r.id);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }
}
const clearStaleSessionRules = serialized(clearStaleSessionRulesImpl);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  // Everything below runs in one async function, so one unexpected
  // rejection partway through (DNR calls especially - see
  // reconcileSiteRules/loadImage) would otherwise silently skip every
  // later step in this invocation, leaving the icon/badge/menu stuck
  // until the next change. Catch and log instead, so a single failure
  // can't freeze the rest of the UI feedback.
  try {
    // Only reload already-open tabs' placeholders when blocking genuinely
    // became *more permissive* than it was a moment ago - never on the
    // initial defaults being written at install, and never for an
    // unrelated settings change (e.g. the size threshold), which would
    // otherwise force-load every placeholder on every open tab for no
    // reason.
    let becameMorePermissive = false;

    if (changes.siteAllowlist) {
      const oldList = changes.siteAllowlist.oldValue || [];
      const newList = changes.siteAllowlist.newValue || [];
      await reconcileSiteRules();
      if (newList.some((d) => !oldList.includes(d))) becameMorePermissive = true;
    }
    if (changes.globalBlockingEnabled) {
      await applyGlobalRulesetState();
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
  } catch (e) {
    console.error('[CTLI] storage.onChanged handler failed:', e);
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

// Session rules are matched back up by their actual condition (not by
// recomputing the hash) so a probed-around-a-collision id is still found
// correctly later, regardless of how it was resolved when added.
function findSessionRuleFor(existing, url, tabId) {
  return existing.find(
    (r) =>
      r.condition &&
      r.condition.urlFilter === url &&
      Array.isArray(r.condition.tabIds) &&
      r.condition.tabIds.includes(tabId)
  );
}

async function loadImageImpl(url, tabId) {
  if (!url || !tabId) return { ok: false, error: 'missing url or tabId' };

  // sessionRuleId() is a hash, not an allocator - resolve against what's
  // actually registered so two different tab+url pairs can never collide
  // (see reconcileSiteRules above for the same issue on dynamic rules,
  // and why resolving against ground truth matters: an unresolved
  // collision throws "Rule with id <n> does not have a unique ID" as an
  // uncaught rejection).
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const usedIds = new Set(existing.map((r) => r.id));
  const selfRule = findSessionRuleFor(existing, url, tabId);
  const freedIds = new Set(selfRule ? [selfRule.id] : []);
  const id = resolveRuleId(sessionRuleId(tabId, url), usedIds, freedIds, SESSION_RULE_ID_BASE, SESSION_RULE_ID_RANGE);
  const rule = buildTabImageAllowRule(id, url, tabId);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: selfRule ? [selfRule.id] : [],
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
const loadImage = serialized(loadImageImpl);

async function imageLoadedImpl(url, tabId) {
  if (!url || !tabId) return { ok: true };
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const rule = findSessionRuleFor(existing, url, tabId);
  if (!rule) return { ok: true };

  if (pendingSessionTimers.has(rule.id)) {
    clearTimeout(pendingSessionTimers.get(rule.id));
    pendingSessionTimers.delete(rule.id);
  }
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [rule.id] })
    .catch(() => {});
  return { ok: true };
}
const imageLoaded = serialized(imageLoadedImpl);

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
