import axios, { AxiosInstance } from 'axios';
import { BasePlatformClient, createRestaurantId } from './base.js';
import { getCredential } from '../credentials.js';
import { cache, CacheKeys, CacheTTL } from '../services/cache.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { randomUUID } from 'crypto';
import type {
  PlatformName,
  Restaurant,
  RestaurantDetails,
  TimeSlot,
  ReservationParams,
  ReservationResult,
  SearchQuery,
} from '../types/restaurant.js';

const GQL_URL = 'https://www.opentable.com/dapi/fe/gql';
const BOOKING_URL = 'https://www.opentable.com/dapi/booking/make-reservation';

// Persisted query hashes -- these change when OT deploys new frontend builds
const QUERY_HASHES: Record<string, string> = {
  Autocomplete: '3cabca79abcb0db395d3cbebb4d47d41f3ddd69442eba3a57f76b943cceb8cf4',
  RestaurantsAvailability: '55b189ad974cc410bc3c3806dfba757011866babcb67a9a8a9c86464b46e587c',
};

// City coordinates for search
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
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

function getCityCoords(location: string): { lat: number; lng: number } {
  const lower = location.toLowerCase();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) return coords;
  }
  // Default to Austin
  return { lat: 30.2672, lng: -97.7431 };
}

export class OpenTablePlatformClient extends BasePlatformClient {
  readonly name: PlatformName = 'opentable';
  private client: AxiosInstance;

  constructor() {
    super();
    this.client = axios.create({
      baseURL: GQL_URL,
      timeout: 15000,
    });
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.opentable.com',
      'Referer': 'https://www.opentable.com/',
      'x-csrf-token': randomUUID(),
    };
  }

  private async gql(operationName: string, variables: Record<string, unknown>): Promise<any> {
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

  async search(query: SearchQuery): Promise<Restaurant[]> {
    const coords = getCityCoords(query.location);

    try {
      const data = await this.gql('Autocomplete', {
        term: query.query,
        latitude: coords.lat,
        longitude: coords.lng,
        covers: query.partySize || 2,
      });

      const restaurants = data?.data?.autocomplete?.restaurants || [];
      return restaurants.map((r: any) => this.mapToRestaurant(r));
    } catch (error) {
      console.error('OpenTable search error:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  async getAvailability(id: string | number, date: string, partySize: number): Promise<TimeSlot[]> {
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

      const slots: TimeSlot[] = [];
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

  async getDetails(_id: string | number): Promise<RestaurantDetails | null> {
    // OpenTable GraphQL doesn't have a clean details endpoint
    // Return minimal details from what we know
    return null;
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
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
    } catch (error: any) {
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

  async isAvailable(): Promise<boolean> {
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

  async isAuthenticated(): Promise<boolean> {
    const authCookie = await getCredential('opentable-auth-cookie');
    return !!authCookie;
  }

  // Helper: map OT autocomplete result to Restaurant interface
  mapToRestaurant(r: any): Restaurant {
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
  offsetToTime(minutes: number | undefined | null): string {
    if (minutes === undefined || minutes === null) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
}

// Singleton instance
export const openTableClient = new OpenTablePlatformClient();
