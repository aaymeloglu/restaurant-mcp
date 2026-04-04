import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { setCredential, getCredential, getResyAuthStatus, getOpenTableAuthStatus } from './credentials.js';
import { resyClient } from './platforms/resy.js';
import { parseRestaurantId } from './platforms/base.js';
import { findTable, searchRestaurant, getRestaurantById, getRestaurantsByIds, checkAvailability, getBookingOptions, getPlatformHealth, getPlatformClient } from './services/search.js';
import { rateLimiter } from './services/rate-limiter.js';
import { cache } from './services/cache.js';
import { snipeReservation, snipeReservationSchema, listScheduledSnipes, listSnipesSchema, cancelSnipe, cancelSnipeSchema } from './tools/snipe.js';
import { startScheduler, stopScheduler } from './sniper/scheduler.js';

// Re-import the same schemas and registerTools logic from index.js
// We duplicate registerTools here to avoid modifying the original dist/index.js

const findTableSchema = z.object({
    restaurant: z.string().min(1).max(100).describe('Restaurant name'),
    location: z.string().min(1).max(100).describe('City or neighborhood'),
    date: z.string().describe('Date (YYYY-MM-DD) or relative like "friday", "tomorrow"'),
    time: z.string().describe('Preferred time like "noon", "7pm", "around 8"'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
    book: z.boolean().default(true).describe('Automatically book the best available slot'),
});

const searchRestaurantSchema = z.object({
    name: z.string().min(1).max(100).describe('Restaurant name to search for'),
    location: z.string().min(1).max(100).describe('City or neighborhood'),
    date: z.string().optional().describe('Optional date for availability context (YYYY-MM-DD)'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Party size'),
});

const getRestaurantSchema = z.object({
    restaurant_id: z.string().min(1).describe('Restaurant ID in format "platform-id" (e.g., resy-12345, opentable-67890, tock-venue-slug)'),
});

const getRestaurantsSchema = z.object({
    restaurant_ids: z.array(z.string().min(1)).min(1).max(10).describe('Array of restaurant IDs'),
});

const checkAvailabilitySchema = z.object({
    restaurant_id: z.string().min(1).describe('Restaurant ID (e.g., resy-12345, opentable-67890)'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
    time: z.string().optional().describe('Preferred time (e.g., "7pm") to filter results'),
});

const getBookingOptionsSchema = z.object({
    slot_token: z.string().min(1).describe('Slot config token (rgs://...) from availability check'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
});

const makeReservationSchema = z.object({
    slot_token: z.string().min(1).describe('Slot token from availability check (rgs://... for Resy, slotHash for OpenTable)'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
    payment_method_id: z.number().optional().describe('Optional payment method ID (Resy only)'),
    platform: z.enum(['resy', 'opentable']).default('resy').describe('Which platform to book on'),
    restaurant_id: z.string().optional().describe('Restaurant ID (required for OpenTable, e.g. opentable-1062610)'),
    slot_availability_token: z.string().optional().describe('Slot availability token (OpenTable only, from availability check)'),
});

const setOpenTableCookieSchema = z.object({
    auth_cookie: z.string().min(1).describe('The authCke cookie value from OpenTable login'),
    phone: z.string().optional().describe('Phone number used for OT login (for re-auth reference)'),
});

const cancelReservationSchema = z.object({
    reservation_id: z.string().min(1).describe('Reservation ID/token to cancel'),
    platform: z.enum(['resy']).describe('Platform (currently only Resy supported)'),
});

const setCredentialsSchema = z.object({
    platform: z.enum(['resy', 'opentable']).describe('Platform to set credentials for'),
    api_key: z.string().optional().describe('API key (Resy only)'),
    auth_token: z.string().optional().describe('Auth token'),
});

const setLoginSchema = z.object({
    platform: z.enum(['resy']).describe('Platform (Resy only)'),
    email: z.string().email().describe('Account email'),
    password: z.string().min(1).describe('Account password'),
});

const checkAuthStatusSchema = z.object({
    platform: z.enum(['resy', 'opentable', 'tock', 'all']).default('all').describe('Platform to check'),
});

const refreshTokenSchema = z.object({
    platform: z.enum(['resy']).describe('Platform (currently only Resy supported)'),
});

function registerTools(server) {
    server.tool('find_table', 'Find and optionally book a table. One-shot: searches, checks availability, and books.', findTableSchema.shape, async (args) => {
        const input = findTableSchema.parse(args);
        const result = await findTable(input.restaurant, input.location, input.date, input.time, input.party_size, input.book);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('search_restaurants', 'Search for restaurants by name across Resy, OpenTable, and Tock.', searchRestaurantSchema.shape, async (args) => {
        const input = searchRestaurantSchema.parse(args);
        const results = await searchRestaurant(input.name, input.location, input.date, input.party_size);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    });
    server.tool('get_restaurant', 'Get details for a specific restaurant by ID.', getRestaurantSchema.shape, async (args) => {
        const input = getRestaurantSchema.parse(args);
        const result = await getRestaurantById(input.restaurant_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('get_restaurants', 'Get details for multiple restaurants by ID.', getRestaurantsSchema.shape, async (args) => {
        const input = getRestaurantsSchema.parse(args);
        const results = await getRestaurantsByIds(input.restaurant_ids);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    });
    server.tool('check_availability', 'Check available time slots for a restaurant.', checkAvailabilitySchema.shape, async (args) => {
        const input = checkAvailabilitySchema.parse(args);
        const results = await checkAvailability(input.restaurant_id, input.date, input.party_size);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    });
    server.tool('get_booking_options', 'Get book token and payment methods for a time slot. Call this before make_reservation.', getBookingOptionsSchema.shape, async (args) => {
        const input = getBookingOptionsSchema.parse(args);
        try {
            const result = await resyClient.getBookToken(input.slot_token, input.date, input.party_size);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to get booking options' }, null, 2) }] };
        }
    });
    server.tool('make_reservation', 'Book a reservation. Provide the slot_token from check_availability. For Resy: handles book token flow automatically. For OpenTable: requires platform="opentable", restaurant_id, and slot_availability_token.', makeReservationSchema.shape, async (args) => {
        const input = makeReservationSchema.parse(args);
        try {
            // OpenTable booking
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

            // Resy booking (default)
            // Step 1: Get book token from /3/details using the slot config token
            const tokenResult = await resyClient.getBookToken(input.slot_token, input.date, input.party_size);

            // Step 2: Book using the book token
            const bookData = { book_token: tokenResult.bookToken };
            if (input.payment_method_id) {
                bookData.struct_payment_method = JSON.stringify({ id: input.payment_method_id });
            } else {
                // Use default payment method if available
                const defaultPm = tokenResult.paymentMethods.find((p) => p.isDefault);
                if (defaultPm) {
                    bookData.struct_payment_method = JSON.stringify({ id: defaultPm.id });
                }
            }

            const bookResult = await resyClient.request('post', '/3/book', bookData);
            const result = {
                success: true,
                platform: 'resy',
                reservationId: String(bookResult.reservation_id),
                confirmationDetails: `Reservation confirmed! ID: ${bookResult.reservation_id}`,
            };
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            const result = { success: false, platform: input.platform, error: error instanceof Error ? error.message : 'Booking failed' };
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    });
    server.tool('list_reservations', 'List your upcoming reservations.', {}, async () => {
        const reservations = await resyClient.getReservations();
        return { content: [{ type: 'text', text: JSON.stringify(reservations, null, 2) }] };
    });
    server.tool('cancel_reservation', 'Cancel an existing reservation.', cancelReservationSchema.shape, async (args) => {
        const input = cancelReservationSchema.parse(args);
        if (input.platform === 'resy') {
            await resyClient.cancelReservation(input.reservation_id);
            return { content: [{ type: 'text', text: `Reservation ${input.reservation_id} cancelled.` }] };
        }
        return { content: [{ type: 'text', text: 'Only Resy cancellations are currently supported.' }] };
    });
    server.tool('set_credentials', 'Securely store API credentials.', setCredentialsSchema.shape, async (args) => {
        const input = setCredentialsSchema.parse(args);
        const stored = [];
        if (input.platform === 'resy') {
            if (input.api_key) { await setCredential('resy-api-key', input.api_key); stored.push('API key'); }
            if (input.auth_token) { await setCredential('resy-auth-token', input.auth_token); stored.push('auth token'); }
        } else {
            if (input.auth_token) { await setCredential('opentable-token', input.auth_token); stored.push('auth token'); }
        }
        return { content: [{ type: 'text', text: stored.length > 0 ? `Stored ${stored.join(' and ')} for ${input.platform}.` : 'No credentials provided to store.' }] };
    });
    server.tool('set_login', 'Store email/password for automatic token refresh.', setLoginSchema.shape, async (args) => {
        const input = setLoginSchema.parse(args);
        if (input.platform === 'resy') {
            try {
                await resyClient.login(input.email, input.password);
                return { content: [{ type: 'text', text: 'Login successful! Token will auto-refresh when needed.' }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `Login failed: ${error instanceof Error ? error.message : 'Invalid credentials'}` }] };
            }
        }
        return { content: [{ type: 'text', text: 'Only Resy login is currently supported.' }] };
    });
    server.tool('check_auth_status', 'Check if credentials are configured and valid.', checkAuthStatusSchema.shape, async (args) => {
        const input = checkAuthStatusSchema.parse(args);
        const statuses = [];
        if (input.platform === 'resy' || input.platform === 'all') {
            const status = await getResyAuthStatus();
            const isValid = status.hasAuthToken ? await resyClient.isAuthenticated() : false;
            statuses.push({ ...status, isValid });
        }
        if (input.platform === 'opentable' || input.platform === 'all') {
            const status = await getOpenTableAuthStatus();
            statuses.push({ ...status, isValid: true });
        }
        if (input.platform === 'tock' || input.platform === 'all') {
            statuses.push({ platform: 'tock', hasApiKey: false, hasAuthToken: false, hasLogin: false, isValid: true });
        }
        return { content: [{ type: 'text', text: JSON.stringify(statuses, null, 2) }] };
    });
    server.tool('refresh_token', 'Manually refresh authentication token.', refreshTokenSchema.shape, async (args) => {
        const input = refreshTokenSchema.parse(args);
        if (input.platform === 'resy') {
            const email = await getCredential('resy-email');
            const password = await getCredential('resy-password');
            if (!email || !password) return { content: [{ type: 'text', text: 'No login credentials stored. Use set_login first.' }] };
            try {
                await resyClient.login(email, password);
                return { content: [{ type: 'text', text: 'Token refreshed successfully!' }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
            }
        }
        return { content: [{ type: 'text', text: 'Only Resy token refresh is supported.' }] };
    });
    server.tool('set_opentable_cookie', 'Store OpenTable auth cookie obtained via browser login.', setOpenTableCookieSchema.shape, async (args) => {
        const input = setOpenTableCookieSchema.parse(args);
        await setCredential('opentable-auth-cookie', input.auth_cookie);
        if (input.phone) {
            await setCredential('opentable-phone', input.phone);
        }
        return { content: [{ type: 'text', text: 'OpenTable auth cookie stored. Booking is now available.' }] };
    });
    server.tool('snipe_reservation', 'Schedule an automatic booking attempt.', snipeReservationSchema.shape, async (args) => {
        const input = snipeReservationSchema.parse(args);
        const result = await snipeReservation(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('list_snipes', 'View all scheduled snipe attempts.', listSnipesSchema.shape, async (args) => {
        const input = listSnipesSchema.parse(args);
        const results = await listScheduledSnipes(input);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    });
    server.tool('cancel_snipe', 'Cancel a scheduled snipe attempt.', cancelSnipeSchema.shape, async (args) => {
        const input = cancelSnipeSchema.parse(args);
        const result = await cancelSnipe(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('get_platform_status', 'Check health and rate limit status of all platforms.', {}, async () => {
        const health = await getPlatformHealth();
        const rateLimits = rateLimiter.getAllStatus();
        const cacheStats = cache.stats();
        const status = { platforms: Object.entries(health).map(([platform, available]) => ({ platform, available, rateLimit: rateLimits.find((r) => r.platform === platform) })), cache: cacheStats };
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    });
}

const mcpServer = new McpServer({ name: 'restaurant-reservations', version: '2.0.0' });
registerTools(mcpServer);

async function main() {
    await startScheduler();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    process.on('SIGINT', () => {
        cache.destroy();
        stopScheduler();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        cache.destroy();
        stopScheduler();
        process.exit(0);
    });
}

main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
