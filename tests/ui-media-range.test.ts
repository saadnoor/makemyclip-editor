import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/ui/server.js';

describe('parseRange', () => {
  it('returns null without a header, so the whole file is sent', () => {
    expect(parseRange(undefined, 100)).toBeNull();
  });
  it('reads a closed range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual([0, 9]);
  });
  it('reads an open-ended range to the end of the file', () => {
    expect(parseRange('bytes=90-', 100)).toEqual([90, 99]);
  });
  it('reads a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
  });
  it('clamps an end past the file', () => {
    expect(parseRange('bytes=50-500', 100)).toEqual([50, 99]);
  });
  it('rejects a start past the file', () => {
    expect(parseRange('bytes=200-300', 100)).toBe('invalid');
  });
  it('answers a multi-range request with the whole file', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});
