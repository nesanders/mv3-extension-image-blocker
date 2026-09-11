// Content script: detects images blocked by the static DNR rule (they fire
// a normal `error` event, same as any broken image), renders a placeholder
// in their place, and drives the click-to-load flow. `lib/domain.js`,
// `lib/rules.js` and `lib/decisions.js` are loaded before this file (see
// manifest.json) and expose their helpers as plain globals.
(function () {
  'use strict';

  const STATE = { blocked: 'blocked', loading: 'loading', loaded: 'loaded', failed: 'failed' };
  const DEFAULT_BOX = { width: 120, height: 90 };
  const DEFAULTS = {
    globalBlockingEnabled: true,
    siteAllowlist: [],
    sizeThresholdEnabled: false,
    sizeThresholdKB: 50
  };

  // container (an <img>, or the <picture> wrapping one) -> { ph, img }
  const placeholderMap = new Map();

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function getSettingsFromStorage() {
    return chrome.storage.local.get(DEFAULTS);
  }

  function getDims(img) {
    const wAttr = parseInt(img.getAttribute('width'), 10);
    const hAttr = parseInt(img.getAttribute('height'), 10);
    if (wAttr > 0 && hAttr > 0) return { width: wAttr, height: hAttr };

    const wStyle = parseInt(img.style.width, 10);
    const hStyle = parseInt(img.style.height, 10);
    if (wStyle > 0 && hStyle > 0) return { width: wStyle, height: hStyle };

    return Object.assign({}, DEFAULT_BOX);
  }

  // --- <img>/<picture> placeholder handling --------------------------------

  async function handleImgError(event) {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;

    const state = img.dataset.ctliState;
    if (state === STATE.loading) {
      onRetryFailed(img);
      return;
    }
    if (state) return; // already showing a placeholder / already loaded

    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) return;

    img.dataset.ctliOriginalSrc = src;
    img.dataset.ctliState = STATE.blocked;

    const settings = await getSettingsFromStorage();
    const container = img.closest('picture') || img;

    if (settings.sizeThresholdEnabled) {
      const resp = await sendMessage({ type: 'checkSize', url: src });
      const sizeBytes = resp && resp.sizeBytes;
      if (shouldAutoLoad(sizeBytes, settings.sizeThresholdEnabled, settings.sizeThresholdKB)) {
        loadImageForElement(img, container);
        return;
      }
      showPlaceholder(img, container, sizeBytes);
      return;
    }

    showPlaceholder(img, container, null);
  }

  function showPlaceholder(img, container, sizeBytes) {
    if (placeholderMap.has(container)) return;

    const { width, height } = getDims(img);
    const ph = document.createElement('div');
    ph.className = 'ctli-placeholder';
    ph.style.width = width + 'px';
    ph.style.height = height + 'px';
    ph.tabIndex = 0;
    ph.setAttribute('role', 'button');
    ph.setAttribute('aria-label', 'Tap to load image');

    const icon = document.createElement('span');
    icon.className = 'ctli-icon';
    icon.textContent = '\u{1F5BC}️';

    const label = document.createElement('span');
    label.className = 'ctli-label';
    const sizeLabel = formatSizeLabel(sizeBytes);
    label.textContent = sizeLabel ? sizeLabel + ' · Tap to load' : 'Tap to load image';

    ph.appendChild(icon);
    ph.appendChild(label);

    const onActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadImageForElement(img, container);
    };
    ph.addEventListener('click', onActivate);
    ph.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onActivate(e);
    });

    container.dataset.ctliHandled = '1';
    container.style.setProperty('display', 'none', 'important');
    container.insertAdjacentElement('beforebegin', ph);
    placeholderMap.set(container, { ph, img });
  }

  function updatePlaceholderStatus(container, text, isError) {
    const entry = placeholderMap.get(container);
    if (!entry) return;
    const label = entry.ph.querySelector('.ctli-label');
    if (label) label.textContent = text;
    entry.ph.classList.toggle('ctli-error', !!isError);
  }

  function removePlaceholder(container) {
    const entry = placeholderMap.get(container);
    if (entry && entry.ph.parentNode) entry.ph.parentNode.removeChild(entry.ph);
    placeholderMap.delete(container);
    container.style.removeProperty('display');
    delete container.dataset.ctliHandled;
  }

  async function loadImageForElement(img, container) {
    img.dataset.ctliState = STATE.loading;
    updatePlaceholderStatus(container, 'Loading…', false);

    const url = img.dataset.ctliOriginalSrc || img.currentSrc || img.src;
    const resp = await sendMessage({ type: 'loadImage', url });
    if (!resp || !resp.ok) {
      onRetryFailed(img);
      return;
    }

    img.addEventListener('load', () => onLoadSuccess(img, container, url), { once: true });
    // A failed reload surfaces through the same delegated `error` listener
    // (handleImgError sees dataset.ctliState === 'loading' and routes to
    // onRetryFailed), so no separate error listener is needed here.
    // A `loading="lazy"` image can otherwise defer the reassigned src
    // until the browser's own intersection heuristic decides to fetch it,
    // which may not be immediate even when the element is on-screen - the
    // person just tapped it, so load it now.
    if (img.loading === 'lazy') img.loading = 'eager';
    img.removeAttribute('src');
    requestAnimationFrame(() => {
      img.src = url;
    });
  }

  function onLoadSuccess(img, container, url) {
    img.dataset.ctliState = STATE.loaded;
    sendMessage({ type: 'imageLoaded', url });
    removePlaceholder(container);
  }

  function onRetryFailed(img) {
    img.dataset.ctliState = STATE.failed;
    const container = img.closest('picture') || img;
    updatePlaceholderStatus(container, 'Failed to load — tap to retry', true);
  }

  document.addEventListener('error', handleImgError, true);

  // --- CSS background-image (best-effort, inline styles only) --------------

  const bgHandled = new WeakSet();

  function scanInlineBackgroundImages(root) {
    if (!root) return;
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.style && root.style.backgroundImage) handleBackgroundImageElement(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[style*="background-image"]').forEach(handleBackgroundImageElement);
    }
  }

  function handleBackgroundImageElement(el) {
    if (bgHandled.has(el)) return;
    const match = /url\((['"]?)([^'")]+)\1\)/.exec(el.style.backgroundImage || '');
    if (!match) return;
    const url = match[2];
    if (!url || url.startsWith('data:')) return;
    bgHandled.add(el);

    const probe = new Image();
    probe.addEventListener('error', () => showBackgroundPlaceholder(el, url));
    probe.src = url;
  }

  function showBackgroundPlaceholder(el, url) {
    if (el.dataset.ctliBgHandled) return;
    el.dataset.ctliBgHandled = '1';

    const overlay = document.createElement('div');
    overlay.className = 'ctli-bg-placeholder';
    overlay.textContent = 'Tap to load background image';
    overlay.tabIndex = 0;
    overlay.setAttribute('role', 'button');

    if (getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
    el.appendChild(overlay);

    const activate = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.textContent = 'Loading…';
      const resp = await sendMessage({ type: 'loadImage', url });
      if (!resp || !resp.ok) {
        overlay.textContent = 'Failed — tap to retry';
        return;
      }
      const original = el.style.backgroundImage;
      el.style.backgroundImage = 'none';
      requestAnimationFrame(() => {
        el.style.backgroundImage = original;
      });
      overlay.remove();
      delete el.dataset.ctliBgHandled;
      sendMessage({ type: 'imageLoaded', url });
    };
    overlay.addEventListener('click', activate);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
  }

  function startBackgroundImageObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach(scanInlineBackgroundImages);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scanInlineBackgroundImages(document.documentElement);
  }

  if (document.documentElement) {
    startBackgroundImageObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startBackgroundImageObserver, { once: true });
  }

  // --- Reacting to toggles (site/global) and "load all images" -------------

  function reloadAllPlaceholders() {
    for (const [container, entry] of placeholderMap) {
      const { img } = entry;
      if (img.dataset.ctliState === STATE.blocked || img.dataset.ctliState === STATE.failed) {
        loadImageForElement(img, container);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'reloadPlaceholders') {
      reloadAllPlaceholders();
    }
  });
})();
