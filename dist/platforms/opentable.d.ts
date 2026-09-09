import { BasePlatformClient } from './base.js';
import type { PlatformName, Restaurant, RestaurantDetails, TimeSlot, ReservationParams, ReservationResult, SearchQuery } from '../types/restaurant.js';
/**
 * Browser session injected via the set_opentable_session tool.
 * OpenTable sits behind Akamai, so requests must carry real browser cookies
 * and the page's CSRF token; impit supplies a matching Chrome TLS fingerprint.
 */
export interface OpenTableSession {
    cookies: string;
    csrfToken: string;
    hashes: Record<string, string>;
    authCookie: string | null;
}
export declare class OpenTablePlatformClient extends BasePlatformClient {
    readonly name: PlatformName;
    private client;
    private _session;
    constructor();
    /**
     * Load session from stored credentials. Session includes:
     * - cookies: full cookie string for OT requests
     * - csrfToken: x-csrf-token from OT page
     * - hashes: persisted query hashes (optional override)
     * - authCookie: authCke value for booking (optional, separate from session cookies)
     */
    getSession(): Promise<OpenTableSession | null>;
    /**
     * Store a new session. Called by the set_opentable_session tool.
     */
    setSession(cookies: string, csrfToken: string, hashes: Record<string, string> | null, authCookie: string | null): Promise<void>;
    private getHeaders;
    private gql;
    search(query: SearchQuery): Promise<Restaurant[]>;
    getAvailability(id: string | number, date: string, partySize: number, requestedTime?: string): Promise<TimeSlot[]>;
    getDetails(_id: string | number): Promise<RestaurantDetails | null>;
    makeReservation(params: ReservationParams): Promise<ReservationResult>;
    isAvailable(): Promise<boolean>;
    isAuthenticated(): Promise<boolean>;
    mapToRestaurant(r: any): Restaurant;
    offsetToTime(minutes: number | undefined | null): string;
}
export declare const openTableClient: OpenTablePlatformClient;
