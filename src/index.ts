#!/usr/bin/env node
/**
 * restaurant-mcp -- stdio MCP server exposing Resy, OpenTable and Tock
 * search, availability, booking and reservation sniping.
 */
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

import {
  setCredential,
  getCredential,
  getResyAuthStatus,
  getOpenTableAuthStatus,
} from './credentials.js';
import { resyClient } from './platforms/resy.js';
import { openTableClient } from './platforms/opentable.js';
import {
  findTable,
  searchRestaurant,
  getRestaurantById,
  getRestaurantsByIds,
  checkAvailability,
  getPlatformHealth,
} from './services/search.js';
import { rateLimiter } from './services/rate-limiter.js';
import { cache } from './services/cache.js';
import {
  snipeReservation,
  snipeReservationSchema,
  listScheduledSnipes,
  listSnipesSchema,
  cancelSnipe,
  cancelSnipeSchema,
} from './tools/snipe.js';
import { startScheduler, stopScheduler } from './sniper/scheduler.js';

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function text(value: unknown): ToolResult {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: body }] };
}

function failure(value: unknown): ToolResult {
  return { ...text(value), isError: true };
}

// ---------------------------------------------------------------------------
// Annotation presets
// ---------------------------------------------------------------------------

const READ_REMOTE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const READ_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const BOOK_REMOTE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CANCEL_REMOTE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

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

const setOpenTableSessionSchema = z.object({
  cookies: z.string().min(1).describe('Full cookie string from browser (document.cookie) after loading opentable.com'),
  csrf_token: z.string().min(1).describe('CSRF token from window.__CSRF_TOKEN__ on opentable.com'),
  hashes: z.record(z.string(), z.string()).optional().describe('Optional updated persisted query hashes (e.g. {"Autocomplete": "abc...", "RestaurantsAvailability": "def..."})'),
  auth_cookie: z.string().optional().describe('authCke cookie value from OpenTable login (for booking, not needed for search/availability)'),
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  server.registerTool('find_table', {
    title: 'Find a table',
    description: 'Find and optionally book a table. One-shot: searches, checks availability, and books.',
    inputSchema: findTableSchema.shape,
    annotations: BOOK_REMOTE,
  }, async (input) => {
    const result = await findTable(input.restaurant, input.location, input.date, input.time, input.party_size, input.book);
    return text(result);
  });

  server.registerTool('search_restaurants', {
    title: 'Search restaurants',
    description: 'Search for restaurants by name across Resy, OpenTable, and Tock.',
    inputSchema: searchRestaurantSchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => {
    const results = await searchRestaurant(input.name, input.location, input.date, input.party_size);
    return text(results);
  });

  server.registerTool('get_restaurant', {
    title: 'Get restaurant',
    description: 'Get details for a specific restaurant by ID.',
    inputSchema: getRestaurantSchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => text(await getRestaurantById(input.restaurant_id)));

  server.registerTool('get_restaurants', {
    title: 'Get restaurants',
    description: 'Get details for multiple restaurants by ID.',
    inputSchema: getRestaurantsSchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => text(await getRestaurantsByIds(input.restaurant_ids)));

  server.registerTool('check_availability', {
    title: 'Check availability',
    description: 'Check available time slots for a restaurant.',
    inputSchema: checkAvailabilitySchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => {
    const results = await checkAvailability(input.restaurant_id, input.date, input.party_size);
    return text(results);
  });

  server.registerTool('get_booking_options', {
    title: 'Get booking options',
    description: 'Get book token and payment methods for a time slot. Call this before make_reservation.',
    inputSchema: getBookingOptionsSchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => {
    try {
      const result = await resyClient.getBookToken(input.slot_token, input.date, input.party_size);
      return text(result);
    } catch (error) {
      return failure({ error: error instanceof Error ? error.message : 'Failed to get booking options' });
    }
  });

  server.registerTool('make_reservation', {
    title: 'Make reservation',
    description: 'Book a reservation. Provide the slot_token from check_availability. For Resy: handles book token flow automatically. For OpenTable: requires platform="opentable", restaurant_id, and slot_availability_token.',
    inputSchema: makeReservationSchema.shape,
    annotations: BOOK_REMOTE,
  }, async (input) => {
    try {
      if (input.platform === 'opentable') {
        const result = await openTableClient.makeReservation({
          restaurantId: input.restaurant_id || 'opentable-0',
          platform: 'opentable',
          slotId: input.slot_token,
          date: input.date,
          partySize: input.party_size,
          token: input.slot_availability_token || input.slot_token,
        });
        return result.success ? text(result) : failure(result);
      }

      // Resy: exchange the slot config token for a book token, then book.
      const tokenResult = await resyClient.getBookToken(input.slot_token, input.date, input.party_size);
      const paymentMethodId = input.payment_method_id
        ?? tokenResult.paymentMethods.find((p) => p.isDefault)?.id;
      const bookResult = await resyClient.bookWithToken(tokenResult.bookToken, paymentMethodId);
      return text({
        success: true,
        platform: 'resy',
        reservationId: String(bookResult.reservation_id),
        confirmationDetails: `Reservation confirmed! ID: ${bookResult.reservation_id}`,
      });
    } catch (error) {
      return failure({
        success: false,
        platform: input.platform,
        error: error instanceof Error ? error.message : 'Booking failed',
      });
    }
  });

  server.registerTool('list_reservations', {
    title: 'List reservations',
    description: 'List your Resy reservations, most recent first (includes past ones; status is upcoming, finished, or no_show). reservationId is the token to pass to cancel_reservation.',
    annotations: READ_REMOTE,
  }, async () => text(await resyClient.getReservations()));

  server.registerTool('cancel_reservation', {
    title: 'Cancel reservation',
    description: 'Cancel an existing reservation.',
    inputSchema: cancelReservationSchema.shape,
    annotations: CANCEL_REMOTE,
  }, async (input) => {
    if (input.platform === 'resy') {
      await resyClient.cancelReservation(input.reservation_id);
      return text(`Reservation ${input.reservation_id} cancelled.`);
    }
    return failure('Only Resy cancellations are currently supported.');
  });

  server.registerTool('set_credentials', {
    title: 'Set credentials',
    description: 'Securely store API credentials.',
    inputSchema: setCredentialsSchema.shape,
    annotations: WRITE_LOCAL,
  }, async (input) => {
    const stored: string[] = [];
    if (input.platform === 'resy') {
      if (input.api_key) { await setCredential('resy-api-key', input.api_key); stored.push('API key'); }
      if (input.auth_token) { await setCredential('resy-auth-token', input.auth_token); stored.push('auth token'); }
    } else if (input.auth_token) {
      await setCredential('opentable-token', input.auth_token);
      stored.push('auth token');
    }
    return text(stored.length > 0 ? `Stored ${stored.join(' and ')} for ${input.platform}.` : 'No credentials provided to store.');
  });

  server.registerTool('set_login', {
    title: 'Set login',
    description: 'Store email/password for automatic token refresh.',
    inputSchema: setLoginSchema.shape,
    annotations: WRITE_LOCAL,
  }, async (input) => {
    if (input.platform !== 'resy') return failure('Only Resy login is currently supported.');
    try {
      await resyClient.login(input.email, input.password);
      return text('Login successful! Token will auto-refresh when needed.');
    } catch (error) {
      return failure(`Login failed: ${error instanceof Error ? error.message : 'Invalid credentials'}`);
    }
  });

  server.registerTool('check_auth_status', {
    title: 'Check auth status',
    description: 'Check if credentials are configured and valid.',
    inputSchema: checkAuthStatusSchema.shape,
    annotations: READ_REMOTE,
  }, async (input) => {
    const statuses: unknown[] = [];
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
    return text(statuses);
  });

  server.registerTool('refresh_token', {
    title: 'Refresh token',
    description: 'Manually refresh authentication token.',
    inputSchema: refreshTokenSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    if (input.platform !== 'resy') return failure('Only Resy token refresh is supported.');
    const email = await getCredential('resy-email');
    const password = await getCredential('resy-password');
    if (!email || !password) return failure('No login credentials stored. Use set_login first.');
    try {
      await resyClient.login(email, password);
      return text('Token refreshed successfully!');
    } catch (error) {
      return failure(`Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  server.registerTool('set_opentable_session', {
    title: 'Set OpenTable session',
    description: 'Inject OpenTable browser session (cookies + CSRF token) for API access. Requires loading opentable.com in Playwright first to solve Akamai bot challenge.',
    inputSchema: setOpenTableSessionSchema.shape,
    annotations: WRITE_LOCAL,
  }, async (input) => {
    await openTableClient.setSession(input.cookies, input.csrf_token, input.hashes || null, input.auth_cookie || null);
    // Invalidate health cache so isAvailable() picks up the new session
    cache.invalidate('health:opentable');
    const parts = ['OpenTable session stored. Search and availability are now active.'];
    if (input.auth_cookie) parts.push('Auth cookie included -- booking is also available.');
    if (input.hashes) parts.push(`Updated ${Object.keys(input.hashes).length} persisted query hash(es).`);
    return text(parts.join(' '));
  });

  server.registerTool('snipe_reservation', {
    title: 'Snipe reservation',
    description: 'Schedule an automatic booking attempt.',
    inputSchema: snipeReservationSchema.shape,
    annotations: BOOK_REMOTE,
  }, async (input) => text(await snipeReservation(input)));

  server.registerTool('list_snipes', {
    title: 'List snipes',
    description: 'View all scheduled snipe attempts.',
    inputSchema: listSnipesSchema.shape,
    annotations: READ_LOCAL,
  }, async (input) => text(await listScheduledSnipes(input)));

  server.registerTool('cancel_snipe', {
    title: 'Cancel snipe',
    description: 'Cancel a scheduled snipe attempt.',
    inputSchema: cancelSnipeSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => text(await cancelSnipe(input)));

  server.registerTool('get_platform_status', {
    title: 'Platform status',
    description: 'Check health and rate limit status of all platforms.',
    annotations: READ_LOCAL,
  }, async () => {
    const health = await getPlatformHealth();
    const rateLimits = rateLimiter.getAllStatus();
    const status = {
      platforms: Object.entries(health).map(([platform, available]) => ({
        platform,
        available,
        rateLimit: rateLimits.find((r) => r.platform === platform),
      })),
      cache: cache.stats(),
    };
    return text(status);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({ name: 'restaurant-reservations', version: SERVER_VERSION });
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await startScheduler();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP wire protocol; all logging goes to stderr.
  console.error(`restaurant-mcp ${SERVER_VERSION} started (stdio)`);

  const shutdown = () => {
    cache.destroy();
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
