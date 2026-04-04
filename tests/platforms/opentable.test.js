import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios
vi.mock('axios', () => {
  const mockInstance = {
    post: vi.fn(),
    get: vi.fn(),
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      __mockInstance: mockInstance,
    },
  };
});

// Mock rate limiter to always allow
vi.mock('../../dist/services/rate-limiter.js', () => ({
  rateLimiter: {
    acquire: vi.fn().mockResolvedValue(true),
  },
}));

// Mock credentials to return null by default
vi.mock('../../dist/credentials.js', () => ({
  getCredential: vi.fn().mockResolvedValue(null),
  setCredential: vi.fn().mockResolvedValue(undefined),
}));

const axios = (await import('axios')).default;
const mockAxios = axios.__mockInstance;
const { cache } = await import('../../dist/services/cache.js');
const { rateLimiter } = await import('../../dist/services/rate-limiter.js');

// Must import after mock setup
const { OpenTablePlatformClient } = await import('../../dist/platforms/opentable.js');

describe('OpenTablePlatformClient', () => {
  let client;

  beforeEach(() => {
    client = new OpenTablePlatformClient();
    // Point the client's internal axios instance to our mock
    client.client = mockAxios;
    cache.clear();
    vi.clearAllMocks();
    // Re-establish rate limiter mock after clearAllMocks
    rateLimiter.acquire.mockResolvedValue(true);
  });

  describe('search', () => {
    it('returns mapped restaurants from Autocomplete response', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          data: {
            autocomplete: {
              restaurants: [
                {
                  restaurantId: 1062610,
                  name: "Perla's Seafood and Oyster Bar",
                  neighborhood: 'South Congress',
                  cuisine: 'Seafood',
                  priceRange: 3,
                  statistics: { reviews: { ratings: { overall: { average: 4.6 } } } },
                },
              ],
            },
          },
        },
      });

      const results = await client.search({
        query: "Perla's",
        location: 'Austin',
        partySize: 2,
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Perla's Seafood and Oyster Bar");
      expect(results[0].platform).toBe('opentable');
      expect(results[0].id).toBe('opentable-1062610');
      expect(results[0].cuisine).toBe('Seafood');
      expect(results[0].rating).toBe(4.6);
      expect(results[0].priceRange).toBe(3);
    });

    it('returns empty array on network error', async () => {
      mockAxios.post.mockRejectedValueOnce(new Error('Network error'));
      const results = await client.search({ query: 'Test', location: 'Austin' });
      expect(results).toEqual([]);
    });
  });

  describe('isAvailable', () => {
    it('returns true when autocomplete responds 200', async () => {
      mockAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { data: { autocomplete: { restaurants: [] } } },
      });
      const result = await client.isAvailable();
      expect(result).toBe(true);
    });

    it('returns false on error', async () => {
      mockAxios.post.mockRejectedValueOnce(new Error('fail'));
      const result = await client.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('getAvailability', () => {
    it('returns mapped slots from RestaurantsAvailability response', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          data: {
            availability: [{
              availabilityDays: [{
                slots: [
                  { isAvailable: true, time: '17:30', slotHash: 'hash1', slotAvailabilityToken: 'token1', type: 'Standard' },
                  { isAvailable: true, time: '18:00', slotHash: 'hash2', slotAvailabilityToken: 'token2', type: 'Standard' },
                  { isAvailable: false, time: '18:30', slotHash: 'hash3', slotAvailabilityToken: 'token3', type: 'Standard' },
                ],
              }],
            }],
          },
        },
      });

      const slots = await client.getAvailability('1062610', '2026-04-04', 2);
      expect(slots).toHaveLength(2); // only isAvailable=true
      expect(slots[0].slotId).toBe('hash1');
      expect(slots[0].token).toBe('token1');
      expect(slots[0].time).toBe('17:30');
      expect(slots[0].platform).toBe('opentable');
    });

    it('returns empty array when no availability', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: { data: { availability: [{ availabilityDays: [] }] } },
      });
      const slots = await client.getAvailability('1062610', '2026-04-04', 2);
      expect(slots).toEqual([]);
    });

    it('returns empty array on error', async () => {
      mockAxios.post.mockRejectedValueOnce(new Error('timeout'));
      const slots = await client.getAvailability('1062610', '2026-04-04', 2);
      expect(slots).toEqual([]);
    });
  });

  describe('makeReservation', () => {
    it('returns auth error when no cookie stored', async () => {
      const result = await client.makeReservation({
        restaurantId: 'opentable-1062610',
        platform: 'opentable',
        slotId: 'hash1',
        date: '2026-04-04',
        partySize: 2,
        token: 'token1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('auth cookie not set');
    });
  });

  describe('offsetToTime', () => {
    it('converts minutes to HH:MM', () => {
      expect(client.offsetToTime(1050)).toBe('17:30');
      expect(client.offsetToTime(0)).toBe('00:00');
      expect(client.offsetToTime(720)).toBe('12:00');
    });

    it('handles undefined', () => {
      expect(client.offsetToTime(undefined)).toBe('');
    });
  });
});
