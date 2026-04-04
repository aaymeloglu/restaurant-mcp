import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../dist/services/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe('tryAcquire', () => {
    it('succeeds within limit', () => {
      expect(limiter.tryAcquire('resy')).toBe(true);
    });

    it('exhausts after max requests', () => {
      // resy has 20 tokens
      for (let i = 0; i < 20; i++) {
        expect(limiter.tryAcquire('resy')).toBe(true);
      }
      expect(limiter.tryAcquire('resy')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('reports correctly after some usage', () => {
      limiter.tryAcquire('resy');
      limiter.tryAcquire('resy');

      const status = limiter.getStatus('resy');
      expect(status.platform).toBe('resy');
      expect(status.available).toBe(18);
      expect(status.max).toBe(20);
      expect(status.isLimited).toBe(false);
      expect(status.nextRefill).toBeGreaterThanOrEqual(0);
    });

    it('isLimited when exhausted', () => {
      for (let i = 0; i < 20; i++) {
        limiter.tryAcquire('resy');
      }
      const status = limiter.getStatus('resy');
      expect(status.isLimited).toBe(true);
      expect(status.available).toBe(0);
    });
  });

  describe('reset', () => {
    it('restores tokens after reset', () => {
      for (let i = 0; i < 20; i++) {
        limiter.tryAcquire('resy');
      }
      expect(limiter.tryAcquire('resy')).toBe(false);

      limiter.reset('resy');
      expect(limiter.tryAcquire('resy')).toBe(true);

      const status = limiter.getStatus('resy');
      expect(status.available).toBe(19);
      expect(status.max).toBe(20);
    });
  });

  describe('getAllStatus', () => {
    it('returns all platforms', () => {
      const statuses = limiter.getAllStatus();
      const platforms = statuses.map(s => s.platform);
      expect(platforms).toContain('resy');
      expect(platforms).toContain('opentable');
      expect(platforms).toContain('tock');
      expect(statuses).toHaveLength(3);
    });
  });

  describe('unknown platform', () => {
    it('uses defaults for unknown platform', () => {
      expect(limiter.tryAcquire('unknown')).toBe(true);

      const status = limiter.getStatus('unknown');
      expect(status.max).toBe(10);
      expect(status.available).toBe(9);
    });
  });
});
