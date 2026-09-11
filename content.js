// Content script: detects images, video, and audio blocked by the static
// DNR rule (they fire a normal `error` event, same as any broken
// image/media element), renders a placeholder in their place, and drives
// the click-to-load flow. `lib/domain.js`, `lib/rules.js` and
// `lib/decisions.js` are loaded before this file (see manifest.json) and
// expose their helpers as plain globals.
(function () {
  'use strict';

  const STATE = { blocked: 'blocked', loading: 'loading', loaded: 'loaded', failed: 'failed' };
  const DEFAULT_BOX = { width: 120, height: 90 };
  // <audio> elements are rarely given explicit width/height (the native
  // control bar is short and wide) - fall back to something that looks
  // like a control bar instead of a big square box.
  const DEFAULT_AUDIO_BOX = { width: 300, height: 32 };
  const DEFAULTS = {
    globalBlockingEnabled: true,
    siteAllowlist: [],
    sizeThresholdEnabled: false,
    sizeThresholdKB: 50
  };

  const PLACEHOLDER_TEXT = {
    image: { icon: '\u{1F5BC}️', label: 'Tap to load image' },
    video: { icon: '\u{25B6}️', label: 'Tap to load video' },
    audio: { icon: '\u{1F50A}', label: 'Tap to load audio' }
  };

  // container (an <img>/<picture>, or a <video>/<audio> element itself) ->
  // { ph, el, kind }
  const placeholderMap = new Map();

  function mediaKind(el) {
    if (el instanceof HTMLImageElement) return 'image';
    if (el instanceof HTMLVideoElement) return 'video';
    if (el instanceof HTMLAudioElement) return 'audio';
    return null;
  }

  // <video>/<audio> can supply their source via a direct `src` attribute
  // or via child <source> elements - currentSrc reflects whichever the
  // browser resolved, but that resolution never completes for a blocked
  // element, so fall back to reading the markup directly.
  function firstSourceUrl(el) {
    const source = el.querySelector && el.querySelector('source[src]');
    return source ? source.src : '';
  }

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

  function getDims(el) {
    const wAttr = parseInt(el.getAttribute('width'), 10);
    const hAttr = parseInt(el.getAttribute('height'), 10);
    if (wAttr > 0 && hAttr > 0) return { width: wAttr, height: hAttr };

    const wStyle = parseInt(el.style.width, 10);
    const hStyle = parseInt(el.style.height, 10);
    if (wStyle > 0 && hStyle > 0) return { width: wStyle, height: hStyle };

    return Object.assign({}, el instanceof HTMLAudioElement ? DEFAULT_AUDIO_BOX : DEFAULT_BOX);
  }

  // --- <img>/<picture>/<video>/<audio> placeholder handling ----------------

  async function handleMediaError(event) {
    const el = event.target;
    const kind = mediaKind(el);
    if (!kind) return;

    const state = el.dataset.ctliState;
    if (state === STATE.loading) {
      onRetryFailed(el);
      return;
    }
    if (state) return; // already showing a placeholder / already loaded

    const src = el.currentSrc || el.src || (kind !== 'image' && firstSourceUrl(el));
    if (!src || src.startsWith('data:')) return;

    el.dataset.ctliOriginalSrc = src;
    el.dataset.ctliState = STATE.blocked;

    const container = kind === 'image' ? el.closest('picture') || el : el;

    if (kind !== 'image') {
      // Video/audio always shows a placeholder and requires a tap,
      // regardless of the size-threshold setting - see
      // lib/decisions.js's shouldAutoLoad.
      showPlaceholder(el, container, null, kind);
      return;
    }

    const settings = await getSettingsFromStorage();
    if (settings.sizeThresholdEnabled) {
      const resp = await sendMessage({ type: 'checkSize', url: src });
      const sizeBytes = resp && resp.sizeBytes;
      if (shouldAutoLoad(sizeBytes, settings.sizeThresholdEnabled, settings.sizeThresholdKB, kind)) {
        loadMediaForElement(el, container);
        return;
      }
      showPlaceholder(el, container, sizeBytes, kind);
      return;
    }

    showPlaceholder(el, container, null, kind);
  }

  function showPlaceholder(el, container, sizeBytes, kind) {
    if (placeholderMap.has(container)) return;

    const { width, height } = getDims(el);
    const text = PLACEHOLDER_TEXT[kind] || PLACEHOLDER_TEXT.image;
    const ph = document.createElement('div');
    ph.className = 'ctli-placeholder ctli-placeholder--' + kind;
    ph.style.width = width + 'px';
    ph.style.height = height + 'px';
    ph.tabIndex = 0;
    ph.setAttribute('role', 'button');
    ph.setAttribute('aria-label', text.label);

    const icon = document.createElement('span');
    icon.className = 'ctli-icon';
    icon.textContent = text.icon;

    const label = document.createElement('span');
    label.className = 'ctli-label';
    const sizeLabel = formatSizeLabel(sizeBytes);
    label.textContent = sizeLabel ? sizeLabel + ' · Tap to load' : text.label;

    ph.appendChild(icon);
    ph.appendChild(label);

    const onActivate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadMediaForElement(el, container);
    };
    ph.addEventListener('click', onActivate);
    ph.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onActivate(e);
    });

    container.dataset.ctliHandled = '1';
    container.style.setProperty('display', 'none', 'important');
    container.insertAdjacentElement('beforebegin', ph);
    placeholderMap.set(container, { ph, el, kind });
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

  async function loadMediaForElement(el, container) {
    const kind = mediaKind(el);
    el.dataset.ctliState = STATE.loading;
    updatePlaceholderStatus(container, 'Loading…', false);

    const url = el.dataset.ctliOriginalSrc || el.currentSrc || el.src;
    const resp = await sendMessage({ type: 'loadImage', url });
    if (!resp || !resp.ok) {
      onRetryFailed(el);
      return;
    }

    // A failed reload surfaces through the same delegated `error` listener
    // (handleMediaError sees dataset.ctliState === 'loading' and routes
    // to onRetryFailed), so no separate error listener is needed here.
    if (kind === 'image') {
      el.addEventListener('load', () => onLoadSuccess(el, container, url), { once: true });
      // A `loading="lazy"` image can otherwise defer the reassigned src
      // until the browser's own intersection heuristic decides to fetch
      // it, which may not be immediate even when on-screen - the person
      // just tapped it, so load it now.
      if (el.loading === 'lazy') el.loading = 'eager';
      el.removeAttribute('src');
      requestAnimationFrame(() => {
        el.src = url;
      });
    } else {
      // <video>/<audio>: `load()` re-runs resource selection against
      // whatever's currently in `src`/child <source> elements - now
      // allowed - rather than us needing to know which form was used.
      // `loadeddata` is the first event that means "there's now
      // something playable," analogous to <img>'s `load`.
      el.addEventListener('loadeddata', () => onLoadSuccess(el, container, url), { once: true });
      el.load();
      if (el.autoplay) el.play().catch(() => {});
    }
  }

  function onLoadSuccess(el, container, url) {
    el.dataset.ctliState = STATE.loaded;
    sendMessage({ type: 'imageLoaded', url });
    removePlaceholder(container);
  }

  function onRetryFailed(el) {
    el.dataset.ctliState = STATE.failed;
    const kind = mediaKind(el);
    const container = kind === 'image' ? el.closest('picture') || el : el;
    updatePlaceholderStatus(container, 'Failed to load — tap to retry', true);
  }

  document.addEventListener('error', handleMediaError, true);

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

  // --- Reacting to toggles (site/global) and "load everything" ---------------

  function reloadAllPlaceholders() {
    for (const [container, entry] of placeholderMap) {
      const { el } = entry;
      if (el.dataset.ctliState === STATE.blocked || el.dataset.ctliState === STATE.failed) {
        loadMediaForElement(el, container);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'reloadPlaceholders') {
      reloadAllPlaceholders();
    }
  });
})();
