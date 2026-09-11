import { describe, it, expect } from 'vitest';
import { shouldAutoLoad, formatSizeLabel } from '../../lib/decisions.js';

describe('shouldAutoLoad', () => {
  it('never auto-loads when the feature is off, regardless of size', () => {
    expect(shouldAutoLoad(1000, false, 50)).toBe(false);
    expect(shouldAutoLoad(1, false, 50)).toBe(false);
  });

  it('auto-loads images strictly below the threshold', () => {
    expect(shouldAutoLoad(40 * 1024, true, 50)).toBe(true);
  });

  it('does not auto-load images at or above the threshold', () => {
    expect(shouldAutoLoad(50 * 1024, true, 50)).toBe(false);
    expect(shouldAutoLoad(60 * 1024, true, 50)).toBe(false);
  });

  it('treats unknown size as "do not auto-load"', () => {
    expect(shouldAutoLoad(null, true, 50)).toBe(false);
    expect(shouldAutoLoad(undefined, true, 50)).toBe(false);
  });

  it('a 0 KB threshold behaves like the feature being off', () => {
    expect(shouldAutoLoad(0, true, 0)).toBe(false);
    expect(shouldAutoLoad(1, true, 0)).toBe(false);
  });

  it('a very high threshold behaves like "always auto-load"', () => {
    expect(shouldAutoLoad(50 * 1024 * 1024, true, 999999)).toBe(true);
  });

  it('ignores NaN sizes', () => {
    expect(shouldAutoLoad(NaN, true, 50)).toBe(false);
  });

  it('never auto-loads video, even when small and under the threshold', () => {
    expect(shouldAutoLoad(1024, true, 50, 'video')).toBe(false);
    expect(shouldAutoLoad(1, true, 999999, 'video')).toBe(false);
  });

  it('never auto-loads audio either, for the same reason as video', () => {
    expect(shouldAutoLoad(1024, true, 50, 'audio')).toBe(false);
  });

  it('treats an explicit "image" mediaType the same as the default (no mediaType)', () => {
    expect(shouldAutoLoad(40 * 1024, true, 50, 'image')).toBe(true);
    expect(shouldAutoLoad(60 * 1024, true, 50, 'image')).toBe(false);
  });
});

describe('formatSizeLabel', () => {
  it('formats bytes under 1KB', () => {
    expect(formatSizeLabel(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatSizeLabel(482 * 1024)).toBe('482 KB');
  });

  it('formats megabytes with one decimal', () => {
    expect(formatSizeLabel(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('returns null for unknown size', () => {
    expect(formatSizeLabel(null)).toBe(null);
    expect(formatSizeLabel(undefined)).toBe(null);
  });
});
