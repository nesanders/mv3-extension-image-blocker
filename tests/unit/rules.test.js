import { describe, it, expect } from 'vitest';
import {
  hashRuleId,
  siteRuleId,
  sessionRuleId,
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
