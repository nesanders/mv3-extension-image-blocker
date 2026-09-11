// Options page: reads current values from storage on load, writes
// immediately on every change (no Save button/step, per spec 4.4).
const DEFAULTS = {
  globalBlockingEnabled: true,
  siteAllowlist: [],
  sizeThresholdEnabled: false,
  sizeThresholdKB: 50
};

const globalEnabledEl = document.getElementById('global-enabled');
const thresholdEnabledEl = document.getElementById('threshold-enabled');
const thresholdKbEl = document.getElementById('threshold-kb');
const allowlistListEl = document.getElementById('allowlist-list');
const addFormEl = document.getElementById('add-form');
const addDomainEl = document.getElementById('add-domain');
const statusEl = document.getElementById('status');

let statusTimer = null;
function flashStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
  }, 1200);
}

function render(settings) {
  globalEnabledEl.checked = settings.globalBlockingEnabled;
  thresholdEnabledEl.checked = settings.sizeThresholdEnabled;
  thresholdKbEl.value = settings.sizeThresholdKB;
  thresholdKbEl.disabled = !settings.sizeThresholdEnabled;

  allowlistListEl.innerHTML = '';
  (settings.siteAllowlist || []).slice().sort().forEach((domain) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => removeDomain(domain));
    li.appendChild(span);
    li.appendChild(btn);
    allowlistListEl.appendChild(li);
  });
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  render(settings);
}

globalEnabledEl.addEventListener('change', () => {
  chrome.storage.local.set({ globalBlockingEnabled: globalEnabledEl.checked });
  flashStatus('Saved');
});

thresholdEnabledEl.addEventListener('change', () => {
  chrome.storage.local.set({ sizeThresholdEnabled: thresholdEnabledEl.checked });
  thresholdKbEl.disabled = !thresholdEnabledEl.checked;
  flashStatus('Saved');
});

thresholdKbEl.addEventListener('change', () => {
  const value = Math.max(0, parseInt(thresholdKbEl.value, 10) || 0);
  thresholdKbEl.value = value;
  chrome.storage.local.set({ sizeThresholdKB: value });
  flashStatus('Saved');
});

async function removeDomain(domain) {
  const { siteAllowlist } = await chrome.storage.local.get({ siteAllowlist: [] });
  const next = siteAllowlist.filter((d) => d !== domain);
  await chrome.storage.local.set({ siteAllowlist: next });
  flashStatus('Saved');
}

addFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = addDomainEl.value.trim().toLowerCase();
  if (!raw) return;
  const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain) return;

  const { siteAllowlist } = await chrome.storage.local.get({ siteAllowlist: [] });
  if (!siteAllowlist.includes(domain)) {
    await chrome.storage.local.set({ siteAllowlist: [...siteAllowlist, domain] });
    flashStatus('Saved');
  }
  addDomainEl.value = '';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') load();
});

load();
