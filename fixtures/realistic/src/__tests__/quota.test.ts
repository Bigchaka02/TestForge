import { afterEach, describe, expect, it, vi } from 'vitest';
import { remainingQuota } from '../quota.js';

describe('remainingQuota', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subtracts the used bytes from the limit', () => {
    expect(remainingQuota(30, 100)).toBe(70);
  });

  it('warns and returns 0 when over the limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(remainingQuota(130, 100)).toBe(0);
    expect(warn).toHaveBeenCalledWith('over quota by 30 bytes');
  });

  it.todo('reports usage per folder');
});
