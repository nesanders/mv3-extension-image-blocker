// Pure declarativeNetRequest rule-object construction helpers, plus the
// deterministic rule-id hash used so the service worker doesn't need to
// persist an id allocator across restarts.
(function (root) {
  'use strict';

  // Rule id namespaces, so site-allow rules and per-tab session rules
  // never collide with each other or with the static block rule (id 1).
  var SITE_RULE_ID_BASE = 100000;
  var SITE_RULE_ID_RANGE = 400000; // 100000..499999
  var SESSION_RULE_ID_BASE = 500000;
  var SESSION_RULE_ID_RANGE = 500000; // 500000..999999

  // Small, deterministic string hash (djb2) folded into [base, base+range).
  // Not collision-proof, but collisions only cause a rebuild of the wrong
  // rule id (harmless - the next reconcile pass fixes it), never a crash.
  function hashRuleId(str, base, range) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    var positive = Math.abs(hash);
    return base + (positive % range);
  }

  function siteRuleId(domain) {
    return hashRuleId('site:' + domain, SITE_RULE_ID_BASE, SITE_RULE_ID_RANGE);
  }

  function sessionRuleId(tabId, url) {
    return hashRuleId('session:' + tabId + ':' + url, SESSION_RULE_ID_BASE, SESSION_RULE_ID_RANGE);
  }

  // Persistent, domain-scoped allow rule: used for the per-site toolbar
  // toggle and the options-page allowlist alike (they share one list).
  function buildSiteAllowRule(id, domain) {
    return {
      id: id,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        requestDomains: [domain],
        resourceTypes: ['image']
      }
    };
  }

  // Session-scoped, single-tab, single-URL allow rule: used for one-off
  // click-to-load of a single image.
  function buildTabImageAllowRule(id, url, tabId) {
    return {
      id: id,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        urlFilter: url,
        tabIds: [tabId],
        resourceTypes: ['image']
      }
    };
  }

  var api = {
    hashRuleId: hashRuleId,
    siteRuleId: siteRuleId,
    sessionRuleId: sessionRuleId,
    buildSiteAllowRule: buildSiteAllowRule,
    buildTabImageAllowRule: buildTabImageAllowRule
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : this);
