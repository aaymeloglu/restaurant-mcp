# Restaurant Reservation MCP Server

A stdio MCP server for searching and booking restaurant reservations. Currently supports Resy with full booking; OpenTable and Tock are stubbed (no public APIs).

## Setup

```bash
git clone git@github.com:aaymeloglu/restaurant-mcp.git
cd restaurant-mcp
npm install
```

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "restaurant-reservations": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/git/restaurant-mcp/dist/index.js"],
      "env": {
        "API_KEY": "<resy-api-key>",
        "RESY_AUTH_TOKEN": "<resy-auth-token>",
        "RESY_EMAIL": "<resy-email>",
        "RESY_PASSWORD": "<resy-password>"
      }
    }
  }
}
```

## Getting Resy Credentials

You need an API key and auth token from resy.com. Open browser dev tools while logged in:

```js
// API key (from Angular config)
angular.element(document.body).injector().get('Config').apiKey

// Auth token (from Redux store)
angular.element(document.body).injector().get('$rootScope').reduxStore.getState().authToken.token
```

Or use the `set_login` tool with your email/password to enable automatic token refresh.

## Booking Flow

### 1. Search

```
search_restaurants(name: "Odd Duck", location: "Austin", date: "2026-04-04", party_size: 2)
```

Returns restaurants with IDs like `resy-136`. The search queries Resy's `/4/find` endpoint and returns all matching venues with availability.

### 2. Check Availability

```
check_availability(restaurant_id: "resy-136", date: "2026-04-04", party_size: 2)
```

Returns time slots, each with a `token` field (the `rgs://` config token needed for booking).

### 3. Book

```
make_reservation(
  slot_token: "rgs://resy/136/2973287/2/2026-04-04/2026-04-04/17:30:00/2/Dining Room",
  date: "2026-04-04",
  party_size: 2
)
```

This handles the full flow: calls `/3/details` to get the book token, then `/3/book` to confirm.

You can also call `get_booking_options` with the same `slot_token` to preview the book token and payment methods before committing.

## One-Shot Booking

```
find_table(restaurant: "Odd Duck", location: "Austin", date: "2026-04-04", time: "6pm", party_size: 2, book: true)
```

Searches, checks availability, and books the best matching slot in one call.

## Reservation Sniper

For popular restaurants that release reservations at specific times:

```
snipe_reservation(
  restaurant_id: "resy-136",
  date: "2026-04-04",
  party_size: 2,
  preferred_times: ["7:00 PM", "7:30 PM"],
  release_time: "2026-03-21T09:00:00"
)
```

Polls every 500ms at release time and books the first matching slot.

## All Tools

| Tool | Description |
|------|-------------|
| `find_table` | One-shot: search, check availability, and book |
| `search_restaurants` | Search by name/location across platforms |
| `check_availability` | Get available time slots |
| `get_booking_options` | Get book token and payment methods for a slot |
| `make_reservation` | Book using a slot token from availability check |
| `list_reservations` | View upcoming Resy reservations |
| `cancel_reservation` | Cancel a Resy booking |
| `set_credentials` | Store API key/token |
| `set_login` | Store email/password for auto-refresh |
| `check_auth_status` | Verify credentials |
| `refresh_token` | Manually refresh auth token |
| `get_platform_status` | Check platform health and rate limits |
| `snipe_reservation` | Schedule auto-booking |
| `list_snipes` | View scheduled snipes |
| `cancel_snipe` | Cancel a scheduled snipe |

## Architecture

- `dist/index.js` -- Single entry point (stdio transport). Hand-maintained, not compiled.
- `dist/platforms/resy.js` -- Resy client (search, availability, booking via unofficial API)
- `dist/platforms/opentable.js` -- Stub (OpenTable shut down their public API)
- `dist/platforms/tock.js` -- Stub (Tock has no public API)
- `src/` -- TypeScript source (reference; not auto-compiled to dist)

## Token Refresh

The Resy auth token expires roughly every 45 days. If `RESY_EMAIL` and `RESY_PASSWORD` are set, the server auto-refreshes on 401/419 errors. You can also manually refresh with `refresh_token`.

## Security

- No credit card data handled; bookings use payment methods saved in your Resy account
- Credentials encrypted at rest via `~/.restaurant-mcp/credentials.enc` (AES-256-GCM)
- Environment variables take precedence over stored credentials
- HTTPS only, rate-limited (20 req/min for Resy)

## Limitations

- Uses unofficial Resy API (could change)
- OpenTable and Tock have no usable public APIs; search/booking requires browser automation
- For personal use only
