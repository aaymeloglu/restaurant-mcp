import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock impit
const mockFetch = vi.fn();
vi.mock('impit', () => ({
  // Use a regular function (not an arrow) so vitest 4 can invoke it with `new`
  // when the client does `new Impit(...)`; the returned object becomes the instance.
  Impit: vi.fn(function () {
    return { fetch: mockFetch };
  }),
  Browser: { Chrome: 'chrome' },
}));

// Mock rate limiter to always allow
vi.mock('../../dist/services/rate-limiter.js', () => ({
  rateLimiter: {
    acquire: vi.fn().mockResolvedValue(true),
  },
}));

// Mock credentials
const mockCredentials = {};
vi.mock('../../dist/credentials.js', () => ({
  getCredential: vi.fn((key) => Promise.resolve(mockCredentials[key] || null)),
  setCredential: vi.fn((key, val) => { mockCredentials[key] = val; return Promise.resolve(); }),
}));

const { cache } = await import('../../dist/services/cache.js');
const { rateLimiter } = await import('../../dist/services/rate-limiter.js');
const { OpenTablePlatformClient } = await import('../../dist/platforms/opentable.js');

function mockJsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) };
}

async function injectSession(client) {
  await client.setSession('_abck=abc123; bm_sz=xyz789', 'csrf-token-123', null, null);
}

describe('OpenTablePlatformClient', () => {
  let client;

  beforeEach(() => {
    client = new OpenTablePlatformClient();
    client._session = null;
    cache.clear();
    for (const key of Object.keys(mockCredentials)) delete mockCredentials[key];
    vi.clearAllMocks();
    rateLimiter.acquire.mockResolvedValue(true);
  });

  describe('isAvailable', () => {
    it('returns false when no session is set', async () => {
      expect(await client.isAvailable()).toBe(false);
    });

    it('returns true when session is set', async () => {
      await injectSession(client);
      expect(await client.isAvailable()).toBe(true);
    });
  });

  describe('search', () => {
    it('returns mapped restaurants from autocompleteResults', async () => {
      await injectSession(client);
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        data: {
          autocomplete: {
            autocompleteResults: [
              { id: '31468', type: 'Restaurant', name: "Perla's Seafood and Oyster Bar", neighborhoodName: 'South Congress', metroName: 'Austin' },
              { id: '33', type: 'Location', name: 'Austin', neighborhoodName: null, metroName: 'Austin' },
            ],
          },
        },
      }));

      const results = await client.search({ query: "Perla's", location: 'Austin', partySize: 2 });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Perla's Seafood and Oyster Bar");
      expect(results[0].platform).toBe('opentable');
      expect(results[0].id).toBe('opentable-31468');
      expect(results[0].neighborhood).toBe('South Congress');
    });

    it('returns empty array when no session', async () => {
      const results = await client.search({ query: 'Test', location: 'Austin' });
      expect(results).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      await injectSession(client);
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const results = await client.search({ query: 'Test', location: 'Austin' });
      expect(results).toEqual([]);
    });
  });

  describe('getAvailability', () => {
    it('returns mapped slots with correct absolute times', async () => {
      await injectSession(client);
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        data: {
          availability: [{
            availabilityDays: [{
              slots: [
                { isAvailable: false, __typename: 'UnavailableSlot' },
                { isAvailable: true, timeOffsetMinutes: 0, slotHash: 'hash1', slotAvailabilityToken: 'token1', type: 'Standard' },
                { isAvailable: true, timeOffsetMinutes: 30, slotHash: 'hash2', slotAvailabilityToken: 'token2', type: 'Standard' },
                { isAvailable: true, timeOffsetMinutes: 90, slotHash: 'hash3', slotAvailabilityToken: 'token3', type: 'Standard' },
              ],
            }],
          }],
        },
      }));

      const slots = await client.getAvailability('31468', '2026-04-05', 2);
      expect(slots).toHaveLength(3);
      expect(slots[0].time).toBe('19:00');
      expect(slots[1].time).toBe('19:30');
      expect(slots[2].time).toBe('20:30');
      expect(slots[0].slotId).toBe('hash1');
      expect(slots[0].token).toBe('token1');
      expect(slots[0].platform).toBe('opentable');
    });

    it('returns empty array when no availability', async () => {
      await injectSession(client);
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        data: { availability: [{ availabilityDays: [] }] },
      }));
      const slots = await client.getAvailability('31468', '2026-04-05', 2);
      expect(slots).toEqual([]);
    });

    it('returns empty array on error', async () => {
      await injectSession(client);
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const slots = await client.getAvailability('31468', '2026-04-05', 2);
      expect(slots).toEqual([]);
    });
  });

  describe('makeReservation', () => {
    it('returns session error when no session', async () => {
      const result = await client.makeReservation({
        restaurantId: 'opentable-31468', platform: 'opentable',
        slotId: 'hash1', date: '2026-04-05', partySize: 2, token: 'token1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('session not initialized');
    });

    it('returns auth error when session exists but no auth cookie', async () => {
      await injectSession(client);
      const result = await client.makeReservation({
        restaurantId: 'opentable-31468', platform: 'opentable',
        slotId: 'hash1', date: '2026-04-05', partySize: 2, token: 'token1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('auth cookie not set');
    });
  });

  describe('setSession', () => {
    it('stores session and makes isAvailable return true', async () => {
      expect(await client.isAvailable()).toBe(false);
      await client.setSession('cookies=abc', 'csrf-123', null, null);
      expect(await client.isAvailable()).toBe(true);
    });

    it('accepts custom hashes', async () => {
      await client.setSession('cookies=abc', 'csrf-123', { Autocomplete: 'newhash' }, null);
      const session = await client.getSession();
      expect(session.hashes.Autocomplete).toBe('newhash');
      expect(session.hashes.RestaurantsAvailability).toBeTruthy();
    });
  });

  describe('offsetToTime', () => {
    it('converts absolute minutes from midnight to HH:MM', () => {
      expect(client.offsetToTime(1050)).toBe('17:30');
      expect(client.offsetToTime(0)).toBe('00:00');
      expect(client.offsetToTime(720)).toBe('12:00');
      expect(client.offsetToTime(1140)).toBe('19:00');
      expect(client.offsetToTime(1230)).toBe('20:30');
    });

    it('handles undefined', () => {
      expect(client.offsetToTime(undefined)).toBe('');
    });
  });
});
