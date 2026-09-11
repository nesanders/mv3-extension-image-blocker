// Pure domain/URL helpers. Loaded as a classic script (importScripts in the
// service worker, a content_scripts entry in the content script) and also
// required directly from unit tests via module.exports.
(function (root) {
  'use strict';

  // Returns the hostname for a URL, or null if the URL can't be parsed
  // (e.g. a data: URI, which callers should already be skipping).
  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }

  // A hostname is "allowlisted" if it equals an allowlist entry, or is a
  // subdomain of one (so allowlisting "example.com" also covers
  // "images.example.com").
  function isAllowlisted(hostname, allowlist) {
    if (!hostname || !Array.isArray(allowlist)) return false;
    return allowlist.some(function (entry) {
      if (!entry) return false;
      return hostname === entry || hostname.endsWith('.' + entry);
    });
  }

  var api = { extractHostname: extractHostname, isAllowlisted: isAllowlisted };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : this);
