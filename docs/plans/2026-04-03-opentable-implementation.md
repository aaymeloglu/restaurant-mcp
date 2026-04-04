# OpenTable GraphQL Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the stubbed OpenTable client with a working implementation using OpenTable's internal GraphQL API for search, availability, and authenticated booking.

**Architecture:** Rewrite `dist/platforms/opentable.js` to hit OpenTable's `/dapi/fe/gql` endpoint with persisted GraphQL queries. Search and availability require no auth. Booking requires an `authCke` cookie obtained via Playwright SMS login (handled outside this MCP server by the calling agent). Add new credential keys for the OT auth cookie and phone number. Wire into existing search/availability/booking flows via the `PlatformClient` interface.

**Tech Stack:** axios (already installed), OpenTable GraphQL persisted queries

---

### Task 1: Add OpenTable credential keys

**Files:**
- Modify: `dist/credentials.js`

**Step 1: Add OT credential keys to ENV_VAR_MAP**

In `dist/credentials.js`, update the `ENV_VAR_MAP` object and `getOpenTableAuthStatus` function:

```js
const ENV_VAR_MAP = {
    'resy-api-key': 'API_KEY',
    'resy-auth-token': 'RESY_AUTH_TOKEN',
    'resy-email': 'RESY_EMAIL',
    'resy-password': 'RESY_PASSWORD',
    'opentable-token': 'OPENTABLE_TOKEN',
    'opentable-auth-cookie': 'OPENTABLE_AUTH_COOKIE',
    'opentable-phone': 'OPENTABLE_PHONE',
};
```

Update `getOpenTableAuthStatus`:

```js
export async function getOpenTableAuthStatus() {
    const [authCookie, phone] = await Promise.all([
        getCredential('opentable-auth-cookie'),
        getCredential('opentable-phone'),
    ]);
    return {
        platform: 'opentable',
        hasApiKey: false,
        hasAuthToken: !!authCookie,
        hasLogin: !!phone,
        phone: phone ? maskCredential(phone) : undefined,
    };
}
```

Also update `src/credentials.ts` CredentialKey type to include the new keys:

```ts
export type CredentialKey =
  | 'resy-api-key'
  | 'resy-auth-token'
  | 'resy-email'
  | 'resy-password'
  | 'opentable-token'
  | 'opentable-auth-cookie'
  | 'opentable-phone';
```

**Step 2: Run existing tests to confirm no breakage**

Run: `cd /Users/aaymeloglu/git/restaurant-mcp && npx vitest run`
Expected: All 139 tests pass

**Step 3: Commit**

```bash
git add dist/credentials.js src/credentials.ts
git commit -m "feat: add OpenTable auth cookie and phone credential keys"
```

---

### Task 2: Rewrite OpenTable client -- search via Autocomplete

**Files:**
- Modify: `dist/platforms/opentable.js`
- Modify: `src/platforms/opentable.ts` (keep in sync)
- Create: `tests/platforms/opentable.test.js`

This is the largest task. Replace the stubbed `OpenTablePlatformClient` with a working GraphQL client. This task covers `search()` and `isAvailable()`. Availability and booking come in later tasks.

**Step 1: Write tests for search**

Create `tests/platforms/opentable.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the helper functions and mock axios for the HTTP calls
// Import after mocking
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

const axios = (await import('axios')).default;
const mockAxios = axios.__mockInstance;

// Must import after mock setup
const { OpenTablePlatformClient } = await import('../../dist/platforms/opentable.js');

describe('OpenTablePlatformClient', () => {
  let client;

  beforeEach(() => {
    client = new OpenTablePlatformClient();
    vi.clearAllMocks();
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
});
```

**Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/platforms/opentable.test.js`
Expected: FAIL (current client has no real implementation)

**Step 3: Rewrite `dist/platforms/opentable.js`**

Replace the entire file contents with:

```js
import axios from 'axios';
import { BasePlatformClient, createRestaurantId } from './base.js';
import { getCredential } from '../credentials.js';
import { cache, CacheKeys, CacheTTL } from '../services/cache.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { randomUUID } from 'crypto';

const GQL_URL = 'https://www.opentable.com/dapi/fe/gql';
const BOOKING_URL = 'https://www.opentable.com/dapi/booking/make-reservation';

// Persisted query hashes -- these change when OT deploys new frontend builds
const QUERY_HASHES = {
    Autocomplete: '3cabca79abcb0db395d3cbebb4d47d41f3ddd69442eba3a57f76b943cceb8cf4',
    RestaurantsAvailability: '55b189ad974cc410bc3c3806dfba757011866babcb67a9a8a9c86464b46e587c',
};

// City coordinates for search
const CITY_COORDS = {
    'austin': { lat: 30.2672, lng: -97.7431 },
    'new york': { lat: 40.7128, lng: -74.0060 },
    'nyc': { lat: 40.7128, lng: -74.0060 },
    'los angeles': { lat: 34.0522, lng: -118.2437 },
    'chicago': { lat: 41.8781, lng: -87.6298 },
    'san francisco': { lat: 37.7749, lng: -122.4194 },
    'miami': { lat: 25.7617, lng: -80.1918 },
    'seattle': { lat: 47.6062, lng: -122.3321 },
    'houston': { lat: 29.7604, lng: -95.3698 },
    'dallas': { lat: 32.7767, lng: -96.7970 },
    'denver': { lat: 39.7392, lng: -104.9903 },
};

function getCityCoords(location) {
    const lower = location.toLowerCase();
    for (const [city, coords] of Object.entries(CITY_COORDS)) {
        if (lower.includes(city)) return coords;
    }
    // Default to Austin
    return { lat: 30.2672, lng: -97.7431 };
}

export class OpenTablePlatformClient extends BasePlatformClient {
    name = 'opentable';
    client;

    constructor() {
        super();
        this.client = axios.create({
            baseURL: GQL_URL,
            timeout: 15000,
        });
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Origin': 'https://www.opentable.com',
            'Referer': 'https://www.opentable.com/',
            'x-csrf-token': randomUUID(),
        };
    }

    async gql(operationName, variables) {
        if (!await rateLimiter.acquire(this.name)) {
            throw new Error('Rate limited. Please try again later.');
        }

        const hash = QUERY_HASHES[operationName];
        if (!hash) throw new Error(`Unknown operation: ${operationName}`);

        const response = await this.client.post(
            `?optype=query&opname=${operationName}`,
            {
                operationName,
                variables,
                extensions: {
                    persistedQuery: { version: 1, sha256Hash: hash },
                },
            },
            { headers: this.getHeaders() }
        );

        if (response.data?.errors?.length > 0) {
            const err = response.data.errors[0];
            if (err.message?.includes('PersistedQueryNotFound')) {
                throw new Error(`OpenTable persisted query hash expired for ${operationName}. Hashes need updating.`);
            }
            throw new Error(`OpenTable GraphQL error: ${err.message}`);
        }

        return response.data;
    }

    async search(query) {
        const coords = getCityCoords(query.location);

        try {
            const data = await this.gql('Autocomplete', {
                term: query.query,
                latitude: coords.lat,
                longitude: coords.lng,
                covers: query.partySize || 2,
            });

            const restaurants = data?.data?.autocomplete?.restaurants || [];
            return restaurants.map((r) => this.mapToRestaurant(r));
        } catch (error) {
            console.error('OpenTable search error:', error instanceof Error ? error.message : error);
            return [];
        }
    }

    async getAvailability(id, date, partySize) {
        const numericId = typeof id === 'string' ? parseInt(this.extractId(id), 10) : id;

        const cacheKey = CacheKeys.availability(this.name, numericId, date, partySize);
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        try {
            const data = await this.gql('RestaurantsAvailability', {
                onlyPop: false,
                requestNewAvailability: true,
                forwardDays: 0,
                requireTimes: true,
                requireTypes: ['Standard', 'Experience'],
                restaurantIds: [numericId],
                date,
                time: '19:00',
                partySize,
                databaseRegion: 'NA',
            });

            const avail = data?.data?.availability?.[0];
            if (!avail?.availabilityDays?.length) return [];

            const slots = [];
            for (const day of avail.availabilityDays) {
                for (const slot of (day.slots || [])) {
                    if (!slot.isAvailable) continue;
                    slots.push({
                        slotId: slot.slotHash || `ot-${numericId}-${date}-${slot.time || ''}`,
                        platform: this.name,
                        time: slot.time || this.offsetToTime(slot.timeOffsetMinutes),
                        type: slot.type || 'Standard',
                        token: slot.slotAvailabilityToken || undefined,
                    });
                }
            }

            cache.set(cacheKey, slots, CacheTTL.AVAILABILITY);
            return slots;
        } catch (error) {
            console.error('OpenTable availability error:', error instanceof Error ? error.message : error);
            return [];
        }
    }

    async getDetails(id) {
        // OpenTable GraphQL doesn't have a clean details endpoint
        // Return minimal details from what we know
        return null;
    }

    async makeReservation(params) {
        const authCookie = await getCredential('opentable-auth-cookie');
        if (!authCookie) {
            return {
                success: false,
                platform: this.name,
                error: 'OpenTable auth cookie not set. Please log in to OpenTable first (use Playwright SMS login flow).',
            };
        }

        const numericId = parseInt(this.extractId(params.restaurantId), 10);

        try {
            const response = await this.client.post(
                BOOKING_URL,
                {
                    restaurantId: numericId,
                    slotHash: params.slotId,
                    slotAvailabilityToken: params.token,
                    partySize: params.partySize,
                    date: params.date,
                },
                {
                    headers: {
                        ...this.getHeaders(),
                        'Cookie': `authCke=${authCookie}`,
                    },
                    baseURL: '',
                }
            );

            if (response.data?.confirmationNumber) {
                cache.invalidate(`availability:${this.name}:*`);
                return {
                    success: true,
                    platform: this.name,
                    reservationId: response.data.confirmationNumber,
                    confirmationDetails: `OpenTable reservation confirmed! Confirmation: ${response.data.confirmationNumber}`,
                };
            }

            return {
                success: false,
                platform: this.name,
                error: response.data?.error || 'Booking failed -- unexpected response',
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Booking failed';
            // If 401/403, cookie likely expired
            if (error?.response?.status === 401 || error?.response?.status === 403) {
                return {
                    success: false,
                    platform: this.name,
                    error: 'OpenTable auth cookie expired. Please re-login via Playwright SMS flow.',
                };
            }
            return { success: false, platform: this.name, error: msg };
        }
    }

    async isAvailable() {
        const cacheKey = CacheKeys.health(this.name);
        const cached = cache.get(cacheKey);
        if (cached !== null) return cached;

        try {
            // Light health check: search for a common term
            await this.gql('Autocomplete', {
                term: 'test',
                latitude: 30.2672,
                longitude: -97.7431,
                covers: 2,
            });
            cache.set(cacheKey, true, CacheTTL.PLATFORM_HEALTH);
            return true;
        } catch (error) {
            console.error('OpenTable isAvailable error:', error instanceof Error ? error.message : error);
            cache.set(cacheKey, false, CacheTTL.PLATFORM_HEALTH);
            return false;
        }
    }

    async isAuthenticated() {
        const authCookie = await getCredential('opentable-auth-cookie');
        return !!authCookie;
    }

    // Helper: map OT autocomplete result to Restaurant interface
    mapToRestaurant(r) {
        return {
            id: createRestaurantId(this.name, r.restaurantId),
            platform: this.name,
            platformId: r.restaurantId,
            name: r.name,
            location: r.neighborhood || '',
            neighborhood: r.neighborhood,
            cuisine: r.cuisine || '',
            cuisines: r.cuisine ? [r.cuisine] : [],
            priceRange: r.priceRange || 0,
            rating: r.statistics?.reviews?.ratings?.overall?.average || 0,
            imageUrl: r.primaryPhoto?.url,
        };
    }

    // Helper: convert offset minutes from midnight to HH:MM
    offsetToTime(minutes) {
        if (minutes === undefined || minutes === null) return '';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
}

// Singleton instance
export const openTableClient = new OpenTablePlatformClient();
```

**Step 4: Run tests**

Run: `npx vitest run tests/platforms/opentable.test.js`
Expected: All pass

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (no regression)

**Step 6: Commit**

```bash
git add dist/platforms/opentable.js src/platforms/opentable.ts tests/platforms/opentable.test.js
git commit -m "feat: implement OpenTable search and availability via GraphQL"
```

---

### Task 3: Add OpenTable availability tests

**Files:**
- Modify: `tests/platforms/opentable.test.js`

**Step 1: Add availability tests to the existing test file**

Append to the `describe('OpenTablePlatformClient')` block:

```js
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
```

**Step 2: Run tests**

Run: `npx vitest run tests/platforms/opentable.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/platforms/opentable.test.js
git commit -m "test: add OpenTable availability and booking tests"
```

---

### Task 4: Wire OpenTable into stdio tool handlers

**Files:**
- Modify: `dist/index.js`

The existing `searchRestaurant()` in `search.js` already iterates all `platformClients` including `openTableClient`. Since we replaced the stub with a real implementation, search and availability should already work through the existing tools.

However, the `make_reservation` tool in `dist/index.js` currently only handles Resy. We need to add an OpenTable path.

**Step 1: Update make_reservation tool handler in `dist/index.js`**

Find the `make_reservation` tool handler. Currently it only calls `resyClient.getBookToken()`. Add an OpenTable branch:

After the existing try block that handles Resy booking, add before the catch:

```js
// For OpenTable: pass slot_token as slotId and token to makeReservation
if (input.slot_token.startsWith('ot-') || input.slot_token.length === 64) {
    // Looks like an OpenTable slotHash
    const { openTableClient } = await import('./platforms/opentable.js');
    const result = await openTableClient.makeReservation({
        restaurantId: 'opentable-0', // ID extracted from slot context
        platform: 'opentable',
        slotId: input.slot_token,
        date: input.date,
        partySize: input.party_size,
        token: input.slot_token, // For OT, token comes from availability
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
```

Actually, the cleaner approach: update `make_reservation` to accept an optional `platform` parameter. If it's `opentable`, route to the OT client. Otherwise default to Resy.

Update the schema:

```js
const makeReservationSchema = z.object({
    slot_token: z.string().min(1).describe('Slot config token from availability check (rgs:// for Resy, slotHash for OpenTable)'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
    payment_method_id: z.number().optional().describe('Optional payment method ID (Resy only)'),
    platform: z.enum(['resy', 'opentable']).default('resy').describe('Which platform to book on'),
    restaurant_id: z.string().optional().describe('Restaurant ID (required for OpenTable, e.g. opentable-1062610)'),
    slot_availability_token: z.string().optional().describe('Slot availability token (OpenTable only)'),
});
```

And update the handler to branch on platform:

```js
server.tool('make_reservation', '...', makeReservationSchema.shape, async (args) => {
    const input = makeReservationSchema.parse(args);
    try {
        if (input.platform === 'opentable') {
            const { openTableClient } = await import('./platforms/opentable.js');
            const result = await openTableClient.makeReservation({
                restaurantId: input.restaurant_id || 'opentable-0',
                platform: 'opentable',
                slotId: input.slot_token,
                date: input.date,
                partySize: input.party_size,
                token: input.slot_availability_token || input.slot_token,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // Resy flow (existing)
        const tokenResult = await resyClient.getBookToken(input.slot_token, input.date, input.party_size);
        // ... rest of existing Resy booking code
    }
});
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass

**Step 3: Commit**

```bash
git add dist/index.js
git commit -m "feat: wire OpenTable booking into make_reservation tool"
```

---

### Task 5: Update check_auth_status for OpenTable

**Files:**
- Modify: `dist/index.js`

**Step 1: Update the check_auth_status handler**

The handler already calls `getOpenTableAuthStatus()`. Since we updated that function in Task 1 to check the new credential keys, this should work. Verify the tool output includes `hasAuthToken` and `phone` for opentable.

**Step 2: Add a `set_opentable_cookie` convenience tool**

Add a new tool to `dist/index.js` for storing the OT auth cookie (obtained via Playwright login by the calling agent):

```js
const setOpenTableCookieSchema = z.object({
    auth_cookie: z.string().min(1).describe('The authCke cookie value from OpenTable login'),
    phone: z.string().optional().describe('Phone number used for OT login (for re-auth reference)'),
});

server.tool('set_opentable_cookie', 'Store OpenTable auth cookie obtained via browser login.', setOpenTableCookieSchema.shape, async (args) => {
    const input = setOpenTableCookieSchema.parse(args);
    await setCredential('opentable-auth-cookie', input.auth_cookie);
    if (input.phone) {
        await setCredential('opentable-phone', input.phone);
    }
    return { content: [{ type: 'text', text: 'OpenTable auth cookie stored. Booking is now available.' }] };
});
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass

**Step 4: Commit**

```bash
git add dist/index.js
git commit -m "feat: add set_opentable_cookie tool and update auth status"
```

---

### Task 6: Live smoke test and push

**Step 1: Run full test suite one final time**

Run: `npx vitest run`
Expected: All pass

**Step 2: Push all commits**

```bash
git push origin master
```

**Step 3: Verify CI passes**

Run: `gh run list --repo aaymeloglu/restaurant-mcp --limit 1`
Expected: Workflow in progress or completed with success

**Step 4: Live test -- search OpenTable**

Use the MCP tool (requires bouncing Claude Code):
```
search_restaurants(name: "Perla's", location: "Austin", date: "2026-04-05", party_size: 2)
```
Expected: Results include `opentable-XXXXXX` entries alongside Resy results

**Step 5: Live test -- check availability**

```
check_availability(restaurant_id: "opentable-XXXXXX", date: "2026-04-05", party_size: 2)
```
Expected: Time slots returned with slotHash and token fields
