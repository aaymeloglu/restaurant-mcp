/**
 * Resy platform client implementing PlatformClient interface
 */
import { BasePlatformClient } from './base.js';
import type { PlatformName, Restaurant, RestaurantDetails, TimeSlot, ReservationParams, ReservationResult, SearchQuery } from '../types/restaurant.js';
export interface ResyBookResponse {
    resy_token: string;
    reservation_id: number;
}
interface ResyLoginResponse {
    id: number;
    token: string;
    first_name: string;
    last_name: string;
    email: string;
}
export declare class ResyPlatformClient extends BasePlatformClient {
    readonly name: PlatformName;
    private client;
    private apiKey;
    private authToken;
    constructor();
    private ensureCredentials;
    private getHeaders;
    private refreshToken;
    private request;
    search(query: SearchQuery): Promise<Restaurant[]>;
    private getLocationSlug;
    private getCityCoordinates;
    getDetails(id: string | number): Promise<RestaurantDetails | null>;
    getAvailability(id: string | number, date: string, partySize: number): Promise<TimeSlot[]>;
    makeReservation(params: ReservationParams): Promise<ReservationResult>;
    isAvailable(): Promise<boolean>;
    isAuthenticated(): Promise<boolean>;
    /**
     * Get book token and payment methods for a slot.
     * @param configToken The rgs:// config token string from a slot
     * @param date Date in YYYY-MM-DD format
     * @param partySize Number of guests
     */
    getBookToken(configToken: string, date: string, partySize: number): Promise<{
        bookToken: string;
        expires: string;
        paymentMethods: Array<{
            id: number;
            isDefault: boolean;
        }>;
    }>;
    /**
     * Book a slot using a book token from getBookToken().
     * @param bookToken The book_token value from /3/details
     * @param paymentMethodId Optional payment method ID; falls back to the account default
     */
    bookWithToken(bookToken: string, paymentMethodId?: number): Promise<ResyBookResponse>;
    login(email: string, password: string): Promise<ResyLoginResponse>;
    getReservations(): Promise<Array<{
        reservationId: string;
        reservationNumber: number;
        venue: {
            name: string;
            location: string;
        };
        date: string;
        time: string;
        partySize: number;
        status: 'upcoming' | 'finished' | 'no_show';
        cancellable: boolean;
    }>>;
    cancelReservation(resyToken: string): Promise<void>;
    private mapToRestaurant;
    private mapToTimeSlot;
}
export declare const resyClient: ResyPlatformClient;
export {};
