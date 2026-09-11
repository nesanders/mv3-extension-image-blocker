import { describe, it, expect } from 'vitest';
import { extractHostname, isAllowlisted } from '../../lib/domain.js';

describe('extractHostname', () => {
  it('extracts the hostname from a normal URL', () => {
    expect(extractHostname('https://example.com/path/image.png')).toBe('example.com');
  });

  it('extracts the hostname including a subdomain', () => {
    expect(extractHostname('https://images.example.com/a.jpg')).toBe('images.example.com');
  });

  it('returns null for an unparseable URL', () => {
    expect(extractHostname('not a url')).toBe(null);
    expect(extractHostname('')).toBe(null);
  });
});

describe('isAllowlisted', () => {
  const allowlist = ['example.com', 'gallery.net'];

  it('matches an exact domain', () => {
    expect(isAllowlisted('example.com', allowlist)).toBe(true);
  });

  it('matches a subdomain of an allowlisted domain', () => {
    expect(isAllowlisted('images.example.com', allowlist)).toBe(true);
  });

  it('does not match an unrelated domain', () => {
    expect(isAllowlisted('other.com', allowlist)).toBe(false);
  });

  it('does not false-positive on a domain that merely shares a suffix', () => {
    expect(isAllowlisted('notexample.com', allowlist)).toBe(false);
  });

  it('handles an empty or missing allowlist', () => {
    expect(isAllowlisted('example.com', [])).toBe(false);
    expect(isAllowlisted('example.com', undefined)).toBe(false);
  });

  it('handles a missing hostname', () => {
    expect(isAllowlisted(null, allowlist)).toBe(false);
  });
});
