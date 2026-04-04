import { Impit, Browser } from 'impit';
import { BasePlatformClient, createRestaurantId } from './base.js';
import { getCredential, setCredential } from '../credentials.js';
import { cache, CacheKeys, CacheTTL } from '../services/cache.js';
import { rateLimiter } from '../services/rate-limiter.js';

const GQL_URL = 'https://www.opentable.com/dapi/fe/gql';
const BOOKING_URL = 'https://www.opentable.com/dapi/booking/make-reservation';

// Default persisted query hashes -- updated via set_opentable_session when stale
const DEFAULT_HASHES = {
    Autocomplete: 'fe1d118abd4c227750693027c2414d43014c2493f64f49bcef5a65274ce9c3c3',
    RestaurantsAvailability: 'b2d05a06151b3cb21d9dfce4f021303eeba288fac347068b29c1cb66badc46af',
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
    return { lat: 30.2672, lng: -97.7431 };
}

export class OpenTablePlatformClient extends BasePlatformClient {
    name = 'opentable';
    client;

    // In-memory session state (loaded from credentials on first use)
    _session = null;

    constructor() {
        super();
        this.client = new Impit({ browser: Browser.Chrome });
    }

    /**
     * Load session from stored credentials. Session includes:
     * - cookies: full cookie string for OT requests
     * - csrfToken: x-csrf-token from OT page
     * - hashes: persisted query hashes (optional override)
     * - authCookie: authCke value for booking (optional, separate from session cookies)
     */
    async getSession() {
        if (this._session) return this._session;

        const [cookies, csrfToken, hashesJson, authCookie] = await Promise.all([
            getCredential('opentable-cookies'),
            getCredential('opentable-csrf'),
            getCredential('opentable-hashes'),
            getCredential('opentable-auth-cookie'),
        ]);

        if (!cookies || !csrfToken) return null;

        let hashes = { ...DEFAULT_HASHES };
        if (hashesJson) {
            try { hashes = { ...hashes, ...JSON.parse(hashesJson) }; } catch {}
        }

        this._session = { cookies, csrfToken, hashes, authCookie };
        return this._session;
    }

    /**
     * Store a new session. Called by the set_opentable_session tool.
     */
    async setSession(cookies, csrfToken, hashes, authCookie) {
        await setCredential('opentable-cookies', cookies);
        await setCredential('opentable-csrf', csrfToken);
        if (hashes) {
            await setCredential('opentable-hashes', JSON.stringify(hashes));
        }
        if (authCookie) {
            await setCredential('opentable-auth-cookie', authCookie);
        }
        this._session = {
            cookies,
            csrfToken,
            hashes: { ...DEFAULT_HASHES, ...(hashes || {}) },
            authCookie: authCookie || this._session?.authCookie || null,
        };
    }

    getHeaders(session) {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Origin': 'https://www.opentable.com',
            'Referer': 'https://www.opentable.com/',
            'x-csrf-token': session.csrfToken,
            'Cookie': session.cookies,
        };
    }

    async gql(operationName, variables) {
        const session = await this.getSession();
        if (!session) {
            throw new Error('OpenTable session not initialized. Use set_opentable_session to inject browser cookies and CSRF token first.');
        }

        if (!await rateLimiter.acquire(this.name)) {
            throw new Error('Rate limited. Please try again later.');
        }

        const hash = session.hashes[operationName];
        if (!hash) throw new Error(`Unknown operation: ${operationName}`);

        const doFetch = () => this.client.fetch(
            `${GQL_URL}?optype=query&opname=${operationName}`,
            {
                method: 'POST',
                headers: this.getHeaders(session),
                body: JSON.stringify({
                    operationName,
                    variables,
                    extensions: {
                        persistedQuery: { version: 1, sha256Hash: hash },
                    },
                }),
            }
        );

        let response = await doFetch();

        // Akamai may challenge the first request from a cold TLS session; retry once on 403
        if (response.status === 403) {
            response = await doFetch();
        }

        if (!response.ok) {
            throw new Error(`OpenTable API returned ${response.status}`);
        }

        const data = await response.json();

        if (data?.errors?.length > 0) {
            const err = data.errors[0];
            if (err.message?.includes('PersistedQueryNotFound')) {
                throw new Error(`OpenTable persisted query hash expired for ${operationName}. Re-run set_opentable_session with fresh hashes.`);
            }
            throw new Error(`OpenTable GraphQL error: ${err.message}`);
        }

        return data;
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

            const results = data?.data?.autocomplete?.autocompleteResults || [];
            // Filter to restaurants only (exclude locations, cuisines, etc.)
            const restaurants = results.filter((r) => r.type === 'Restaurant');
            return restaurants.map((r) => this.mapToRestaurant(r));
        } catch (error) {
            console.error('OpenTable search error:', error instanceof Error ? error.message : error);
            return [];
        }
    }

    async getAvailability(id, date, partySize, requestedTime = '19:00') {
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
                time: requestedTime,
                partySize,
                databaseRegion: 'NA',
            });

            const avail = data?.data?.availability?.[0];
            if (!avail?.availabilityDays?.length) return [];

            // Parse base time for offset calculation
            const [baseH, baseM] = requestedTime.split(':').map(Number);
            const baseMinutes = baseH * 60 + baseM;

            const slots = [];
            for (const day of avail.availabilityDays) {
                for (const slot of (day.slots || [])) {
                    if (!slot.isAvailable) continue;
                    const absoluteMinutes = baseMinutes + (slot.timeOffsetMinutes || 0);
                    const time = this.offsetToTime(absoluteMinutes);
                    slots.push({
                        slotId: slot.slotHash || `ot-${numericId}-${date}-${time}`,
                        platform: this.name,
                        time,
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
        return null;
    }

    async makeReservation(params) {
        const session = await this.getSession();
        if (!session) {
            return {
                success: false,
                platform: this.name,
                error: 'OpenTable session not initialized. Use set_opentable_session first.',
            };
        }

        if (!session.authCookie) {
            return {
                success: false,
                platform: this.name,
                error: 'OpenTable auth cookie not set. Log in to OpenTable via Playwright to get your authCke cookie, then pass it to set_opentable_session.',
            };
        }

        const numericId = parseInt(this.extractId(params.restaurantId), 10);

        try {
            const headers = this.getHeaders(session);
            headers['Cookie'] = `${session.cookies}; authCke=${session.authCookie}`;

            const response = await this.client.fetch(BOOKING_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    restaurantId: numericId,
                    slotHash: params.slotId,
                    slotAvailabilityToken: params.token,
                    partySize: params.partySize,
                    date: params.date,
                }),
            });

            const responseData = await response.json();

            if (responseData?.confirmationNumber) {
                cache.invalidate(`availability:${this.name}:*`);
                return {
                    success: true,
                    platform: this.name,
                    reservationId: responseData.confirmationNumber,
                    confirmationDetails: `OpenTable reservation confirmed! Confirmation: ${responseData.confirmationNumber}`,
                };
            }

            return {
                success: false,
                platform: this.name,
                error: responseData?.error || 'Booking failed -- unexpected response',
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Booking failed';
            if (msg.includes('403') || msg.includes('401') || msg.includes('409')) {
                return {
                    success: false,
                    platform: this.name,
                    error: 'OpenTable session expired. Re-run set_opentable_session with fresh browser cookies.',
                };
            }
            return { success: false, platform: this.name, error: msg };
        }
    }

    async isAvailable() {
        // OT requires browser-injected session cookies.
        // Available = session has been injected.
        const session = await this.getSession();
        return session !== null;
    }

    async isAuthenticated() {
        const session = await this.getSession();
        return !!session?.authCookie;
    }

    mapToRestaurant(r) {
        return {
            id: createRestaurantId(this.name, r.id),
            platform: this.name,
            platformId: Number(r.id),
            name: r.name,
            location: r.metroName || '',
            neighborhood: r.neighborhoodName || '',
            cuisine: '',
            cuisines: [],
            priceRange: 0,
            rating: 0,
        };
    }

    offsetToTime(minutes) {
        if (minutes === undefined || minutes === null) return '';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
}

export const openTableClient = new OpenTablePlatformClient();
