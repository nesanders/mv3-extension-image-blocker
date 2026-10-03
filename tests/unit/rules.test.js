import { describe, it, expect } from 'vitest';
import {
  hashRuleId,
  siteRuleId,
  sessionRuleId,
  resolveRuleId,
  buildSiteAllowRule,
  buildTabImageAllowRule
} from '../../lib/rules.js';

describe('hashRuleId', () => {
  it('is deterministic for the same input', () => {
    expect(hashRuleId('foo', 100, 1000)).toBe(hashRuleId('foo', 100, 1000));
  });

  it('stays within [base, base + range)', () => {
    for (const input of ['a', 'example.com', '12345:https://x.test/y.png']) {
      const id = hashRuleId(input, 500, 200);
      expect(id).toBeGreaterThanOrEqual(500);
      expect(id).toBeLessThan(700);
    }
  });

  it('differs for different inputs (in the common case)', () => {
    expect(hashRuleId('example.com', 0, 1e9)).not.toBe(hashRuleId('other.com', 0, 1e9));
  });
});

describe('siteRuleId / sessionRuleId', () => {
  it('produce ids in disjoint ranges so they can never collide with each other', () => {
    const site = siteRuleId('example.com');
    const session = sessionRuleId(7, 'https://example.com/a.png');
    expect(site).toBeGreaterThanOrEqual(100000);
    expect(site).toBeLessThan(500000);
    expect(session).toBeGreaterThanOrEqual(500000);
    expect(session).toBeLessThan(1000000);
  });

  it('is stable for the same domain / tab+url', () => {
    expect(siteRuleId('example.com')).toBe(siteRuleId('example.com'));
    expect(sessionRuleId(3, 'https://a.test/x.png')).toBe(sessionRuleId(3, 'https://a.test/x.png'));
  });
});

describe('resolveRuleId', () => {
  it('returns the preferred id when it is free', () => {
    const id = resolveRuleId(150000, new Set([1, 2, 3]), new Set(), 100000, 400000);
    expect(id).toBe(150000);
  });

  it('probes forward to the next free id when the preferred one is taken', () => {
    // Reproduces the real "Rule with id <n> does not have a unique ID"
    // crash this was written to fix: two different domains hashing to
    // the same preferred id must still get two distinct resolved ids.
    const used = new Set([150000]);
    const id = resolveRuleId(150000, used, new Set(), 100000, 400000);
    expect(id).toBe(150001);
    expect(used.has(id)).toBe(false);
  });

  it('treats a freed id as available even though it is still in usedIds', () => {
    // Models the "removed in this same batch" case: usedIds is a
    // snapshot taken before building the removal list, so an id about
    // to be freed still appears taken there unless freedIds says
    // otherwise.
    const used = new Set([150000]);
    const id = resolveRuleId(150000, used, new Set([150000]), 100000, 400000);
    expect(id).toBe(150000);
  });

  it('wraps around the range instead of running off the end', () => {
    const base = 100000;
    const range = 10;
    const used = new Set();
    for (let i = base + 5; i < base + range; i++) used.add(i); // fill 100005..100009
    const id = resolveRuleId(100008, used, new Set(), base, range);
    expect(id).toBe(100000); // probing from 100008 wraps past 100009 to 100000
    expect(used.has(id)).toBe(false);
  });

  it('never returns the same id twice across sequential calls that each commit their result', () => {
    const used = new Set();
    const resolved = [];
    for (let i = 0; i < 20; i++) {
      // All inputs hash to the same preferred id on purpose, to force
      // probing every time - the real-world failure mode.
      const id = resolveRuleId(200000, used, new Set(), 100000, 400000);
      used.add(id);
      resolved.push(id);
    }
    expect(new Set(resolved).size).toBe(20);
  });
});

describe('buildSiteAllowRule', () => {
  it('produces a persistent allow rule scoped to the domain and image/media resource types', () => {
    const rule = buildSiteAllowRule(12345, 'example.com');
    expect(rule).toEqual({
      id: 12345,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        requestDomains: ['example.com'],
        resourceTypes: ['image', 'media']
      }
    });
  });
});

describe('buildTabImageAllowRule', () => {
  it('produces a session allow rule scoped to the exact URL, tab, and image/media resource types', () => {
    const rule = buildTabImageAllowRule(999, 'https://example.com/a.png', 42);
    expect(rule).toEqual({
      id: 999,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        urlFilter: 'https://example.com/a.png',
        tabIds: [42],
        resourceTypes: ['image', 'media']
      }
    });
  });
});
