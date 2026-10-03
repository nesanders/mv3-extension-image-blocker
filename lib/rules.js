// Pure declarativeNetRequest rule-object construction helpers, plus a
// deterministic rule-id hash and a collision resolver. The hash alone is
// NOT collision-proof - two different domains (or two different
// tab+url pairs) can hash to the same id - so callers must run it through
// resolveRuleId() against the ids Chrome actually has registered (via
// getDynamicRules()/getSessionRules()) before using it. Skipping that step
// previously caused `chrome.declarativeNetRequest.updateDynamicRules()` to
// throw "Rule with id <n> does not have a unique ID" as an uncaught
// rejection whenever two allowlisted domains happened to hash to the same
// id - see background.js's reconcileSiteRules/loadImage for the fix.
(function (root) {
  'use strict';

  // Rule id namespaces, so site-allow rules and per-tab session rules are
  // easy to tell apart by id alone when debugging (e.g. in the
  // onRuleMatchedDebug log). Dynamic rules and session rules are actually
  // separate collections in Chrome's own API with independent id spaces,
  // so this separation isn't required for correctness - just clarity.
  var SITE_RULE_ID_BASE = 100000;
  var SITE_RULE_ID_RANGE = 400000; // 100000..499999
  var SESSION_RULE_ID_BASE = 500000;
  var SESSION_RULE_ID_RANGE = 500000; // 500000..999999

  // Small, deterministic string hash (djb2) folded into [base, base+range).
  // Deliberately NOT collision-proof by itself (see resolveRuleId).
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

  // Given a preferred id (from siteRuleId/sessionRuleId) and the set of
  // ids Chrome already has registered for that rule collection, returns
  // the preferred id if it's actually free, or linearly probes forward
  // (wrapping within [base, base+range)) until it finds one that is.
  // `freedIds` are ids being removed in this same update call - safe to
  // reuse even though `usedIds` (a snapshot taken before building the
  // removal list) still lists them as taken.
  function resolveRuleId(preferredId, usedIds, freedIds, base, range) {
    if (!usedIds.has(preferredId) || (freedIds && freedIds.has(preferredId))) {
      return preferredId;
    }
    for (var i = 1; i < range; i++) {
      var candidate = base + (((preferredId - base + i) % range) + range) % range;
      if (!usedIds.has(candidate) || (freedIds && freedIds.has(candidate))) {
        return candidate;
      }
    }
    throw new Error('resolveRuleId: no free rule id in range [' + base + ', ' + (base + range) + ')');
  }

  // Matches the static block rule's scope: still images plus "media",
  // which is DNR's only resourceType for <video>/<audio> - it doesn't
  // distinguish between the two, so blocking video necessarily blocks
  // audio elements too.
  var BLOCKED_RESOURCE_TYPES = ['image', 'media'];

  // Persistent, domain-scoped allow rule: used for the per-site toolbar
  // toggle and the options-page allowlist alike (they share one list).
  function buildSiteAllowRule(id, domain) {
    return {
      id: id,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        requestDomains: [domain],
        resourceTypes: BLOCKED_RESOURCE_TYPES
      }
    };
  }

  // Session-scoped, single-tab, single-URL allow rule: used for one-off
  // click-to-load of a single image or video/audio element.
  function buildTabImageAllowRule(id, url, tabId) {
    return {
      id: id,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        urlFilter: url,
        tabIds: [tabId],
        resourceTypes: BLOCKED_RESOURCE_TYPES
      }
    };
  }

  var api = {
    SITE_RULE_ID_BASE: SITE_RULE_ID_BASE,
    SITE_RULE_ID_RANGE: SITE_RULE_ID_RANGE,
    SESSION_RULE_ID_BASE: SESSION_RULE_ID_BASE,
    SESSION_RULE_ID_RANGE: SESSION_RULE_ID_RANGE,
    hashRuleId: hashRuleId,
    siteRuleId: siteRuleId,
    sessionRuleId: sessionRuleId,
    resolveRuleId: resolveRuleId,
    buildSiteAllowRule: buildSiteAllowRule,
    buildTabImageAllowRule: buildTabImageAllowRule
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : this);
