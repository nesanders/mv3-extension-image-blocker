// Pure decision logic for the size-threshold auto-load feature.
(function (root) {
  'use strict';

  // Given a known (or unknown) byte size and the current threshold
  // settings, decide whether an image should auto-load instead of showing
  // a placeholder.
  //
  // - Feature off -> never auto-load (placeholder always shown).
  // - Size unknown (null/undefined) -> never auto-load; treat as "above
  //   threshold" since we can't prove it's cheap.
  // - Otherwise auto-load when strictly below the threshold. A threshold
  //   of 0 KB then naturally never auto-loads (nothing is < 0 bytes),
  //   matching "off" behavior without any special-casing. A very large
  //   threshold naturally auto-loads everything.
  function shouldAutoLoad(sizeBytes, thresholdEnabled, thresholdKB) {
    if (!thresholdEnabled) return false;
    if (sizeBytes === null || sizeBytes === undefined) return false;
    if (typeof sizeBytes !== 'number' || Number.isNaN(sizeBytes)) return false;
    var thresholdBytes = Number(thresholdKB) * 1024;
    return sizeBytes < thresholdBytes;
  }

  // Formats a byte count as a short human label, e.g. "482 KB".
  function formatSizeLabel(sizeBytes) {
    if (sizeBytes === null || sizeBytes === undefined) return null;
    var kb = sizeBytes / 1024;
    if (kb < 1) return Math.max(1, Math.round(sizeBytes)) + ' B';
    if (kb < 1024) return Math.round(kb) + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }

  var api = { shouldAutoLoad: shouldAutoLoad, formatSizeLabel: formatSizeLabel };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : this);
