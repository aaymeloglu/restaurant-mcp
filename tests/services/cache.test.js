import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService, CacheKeys, CacheTTL, hashSearchQuery } from '../../dist/services/cache.js';

describe('CacheService', () => {
  let cache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new CacheService();
  });

  afterEach(() => {
    cache.destroy();
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('returns null for missing key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('stores and retrieves a value', () => {
      cache.set('key1', { data: 'hello' }, 5000);
      expect(cache.get('key1')).toEqual({ data: 'hello' });
    });

    it('stores primitive values', () => {
      cache.set('num', 42, 5000);
      expect(cache.get('num')).toBe(42);
    });
  });

  describe('TTL expiry', () => {
    it('returns value before TTL expires', () => {
      cache.set('key', 'value', 10000);
      vi.advanceTimersByTime(9999);
      expect(cache.get('key')).toBe('value');
    });

    it('returns null after TTL expires', () => {
      cache.set('key', 'value', 10000);
      vi.advanceTimersByTime(10001);
      expect(cache.get('key')).toBeNull();
    });

    it('expires exactly at TTL boundary', () => {
      cache.set('key', 'value', 5000);
      vi.advanceTimersByTime(5001);
      expect(cache.get('key')).toBeNull();
    });
  });

  describe('has', () => {
    it('returns false for missing key', () => {
      expect(cache.has('nope')).toBe(false);
    });

    it('returns true for existing non-expired key', () => {
      cache.set('key', 'val', 5000);
      expect(cache.has('key')).toBe(true);
    });

    it('returns false for expired key', () => {
      cache.set('key', 'val', 1000);
      vi.advanceTimersByTime(1001);
      expect(cache.has('key')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes an existing key', () => {
      cache.set('key', 'val', 5000);
      expect(cache.delete('key')).toBe(true);
      expect(cache.get('key')).toBeNull();
    });

    it('returns false for non-existing key', () => {
      expect(cache.delete('nope')).toBe(false);
    });
  });

  describe('invalidate', () => {
    it('removes keys matching a wildcard pattern', () => {
      cache.set('search:abc', 1, 5000);
      cache.set('search:def', 2, 5000);
      cache.set('details:resy:1', 3, 5000);

      const count = cache.invalidate('search:*');
      expect(count).toBe(2);
      expect(cache.get('search:abc')).toBeNull();
      expect(cache.get('search:def')).toBeNull();
      expect(cache.get('details:resy:1')).toBe(3);
    });

    it('removes keys matching middle wildcard', () => {
      cache.set('details:resy:1', 'a', 5000);
      cache.set('details:opentable:2', 'b', 5000);
      cache.set('details:resy:3', 'c', 5000);

      const count = cache.invalidate('details:resy:*');
      expect(count).toBe(2);
      expect(cache.get('details:opentable:2')).toBe('b');
    });

    it('returns 0 when nothing matches', () => {
      cache.set('foo', 1, 5000);
      expect(cache.invalidate('bar:*')).toBe(0);
    });

    it('exact match without wildcards', () => {
      cache.set('exact', 1, 5000);
      cache.set('exactly', 2, 5000);
      const count = cache.invalidate('exact');
      expect(count).toBe(1);
      expect(cache.get('exactly')).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all entries and resets stats', () => {
      cache.set('a', 1, 5000);
      cache.set('b', 2, 5000);
      cache.get('a');
      cache.get('missing');

      cache.clear();

      // Verify stats are reset before doing any gets (which would add misses)
      const stats = cache.stats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);

      // Verify entries are gone
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('stats', () => {
    it('starts with zero stats', () => {
      const stats = cache.stats();
      expect(stats).toEqual({ size: 0, hits: 0, misses: 0, hitRate: 0 });
    });

    it('tracks hits and misses', () => {
      cache.set('key', 'val', 5000);
      cache.get('key'); // hit
      cache.get('key'); // hit
      cache.get('nope'); // miss

      const stats = cache.stats();
      expect(stats.size).toBe(1);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('counts expired reads as misses', () => {
      cache.set('key', 'val', 1000);
      vi.advanceTimersByTime(1001);
      cache.get('key'); // miss (expired)

      const stats = cache.stats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('removes expired entries on cleanup', () => {
      cache.set('short', 1, 1000);
      cache.set('long', 2, 100000);

      vi.advanceTimersByTime(2000);
      cache.cleanup();

      expect(cache.has('short')).toBe(false);
      expect(cache.has('long')).toBe(true);
    });

    it('auto-runs cleanup via interval', () => {
      cache.set('temp', 1, 1000);
      vi.advanceTimersByTime(61000); // past the 60s interval

      // The entry should have been cleaned up by the interval
      // Access underlying map to check without affecting stats
      expect(cache.has('temp')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('clears the cleanup interval', () => {
      expect(cache.cleanupInterval).not.toBeNull();
      cache.destroy();
      expect(cache.cleanupInterval).toBeNull();
    });

    it('is safe to call twice', () => {
      cache.destroy();
      cache.destroy();
      expect(cache.cleanupInterval).toBeNull();
    });
  });
});

describe('CacheKeys', () => {
  it('generates search keys', () => {
    expect(CacheKeys.search('abc123')).toBe('search:abc123');
  });

  it('generates details keys', () => {
    expect(CacheKeys.details('resy', '42')).toBe('details:resy:42');
  });

  it('generates availability keys', () => {
    expect(CacheKeys.availability('opentable', '7', '2026-04-03', 2)).toBe(
      'availability:opentable:7:2026-04-03:2'
    );
  });

  it('generates health keys', () => {
    expect(CacheKeys.health('tock')).toBe('health:tock');
  });
});

describe('hashSearchQuery', () => {
  it('produces consistent hashes for same input', () => {
    const h1 = hashSearchQuery('sushi', 'austin', 'japanese');
    const h2 = hashSearchQuery('sushi', 'austin', 'japanese');
    expect(h1).toBe(h2);
  });

  it('is case-insensitive', () => {
    const h1 = hashSearchQuery('Sushi', 'AUSTIN', 'Japanese');
    const h2 = hashSearchQuery('sushi', 'austin', 'japanese');
    expect(h1).toBe(h2);
  });

  it('trims whitespace', () => {
    const h1 = hashSearchQuery('  sushi  ', '  austin  ', '  japanese  ');
    const h2 = hashSearchQuery('sushi', 'austin', 'japanese');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different queries', () => {
    const h1 = hashSearchQuery('sushi', 'austin', 'japanese');
    const h2 = hashSearchQuery('tacos', 'austin', 'mexican');
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different locations', () => {
    const h1 = hashSearchQuery('sushi', 'austin', null);
    const h2 = hashSearchQuery('sushi', 'dallas', null);
    expect(h1).not.toBe(h2);
  });

  it('handles undefined cuisine', () => {
    const h1 = hashSearchQuery('sushi', 'austin', undefined);
    const h2 = hashSearchQuery('sushi', 'austin', undefined);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBeGreaterThan(0);
  });

  it('returns a string', () => {
    const hash = hashSearchQuery('test', 'place', 'food');
    expect(typeof hash).toBe('string');
  });
});

describe('CacheTTL', () => {
  it('has expected TTL values', () => {
    expect(CacheTTL.SEARCH_RESULTS).toBe(5 * 60 * 1000);
    expect(CacheTTL.RESTAURANT_DETAILS).toBe(24 * 60 * 60 * 1000);
    expect(CacheTTL.AVAILABILITY).toBe(60 * 1000);
    expect(CacheTTL.PLATFORM_HEALTH).toBe(30 * 1000);
  });
});
