# Restaurant Reservation MCP Server

A stdio MCP server for searching and booking restaurant reservations via Resy and OpenTable.

**Resy** works out of the box with API credentials. **OpenTable** requires a one-time browser session setup (see below).

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
      "args": ["/path/to/restaurant-mcp/dist/index.js"],
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

No OpenTable env vars are needed -- OpenTable credentials are injected at runtime via the `set_opentable_session` tool.

## Platform Setup

### Resy (API credentials)

Resy works via their unofficial API. You need an API key and auth token from resy.com. Open browser dev tools while logged in:

```js
// API key
angular.element(document.body).injector().get('Config').apiKey

// Auth token
angular.element(document.body).injector().get('$rootScope').reduxStore.getState().authToken.token
```

Pass these as `API_KEY` and `RESY_AUTH_TOKEN` env vars. For automatic token refresh on expiry, also set `RESY_EMAIL` and `RESY_PASSWORD`.

### OpenTable (browser session required)

OpenTable's API is behind Akamai Bot Manager, which blocks requests that don't come from a real browser. This server uses [impit](https://github.com/apify/impit) to spoof Chrome's TLS fingerprint, but still requires valid browser cookies and a CSRF token.

**Before OpenTable search/availability will work, you must inject a browser session:**

1. Open `https://www.opentable.com` in a browser (Playwright, Puppeteer, or manually)
2. Extract the CSRF token and cookies:
   ```js
   // In browser console or page.evaluate():
   const csrf = window.__CSRF_TOKEN__;
   const cookies = document.cookie;
   ```
3. Inject them into the MCP server:
   ```
   set_opentable_session(
     cookies: "<full cookie string from document.cookie>",
     csrf_token: "<CSRF token from window.__CSRF_TOKEN__>"
   )
   ```

After this, `search_restaurants` will return results from both Resy and OpenTable in parallel, and `check_availability` will work for `opentable-*` restaurant IDs.

**Session expiry:** The cookies last for a while (hours to days) but will eventually expire. When they do, OT requests will start returning errors. Re-run the browser extraction and `set_opentable_session` to refresh.

**Booking on OpenTable** additionally requires your OpenTable auth cookie (`authCke`), obtained by logging into your OT account in the browser. Pass it as the `auth_cookie` parameter:
```
set_opentable_session(
  cookies: "...",
  csrf_token: "...",
  auth_cookie: "<authCke cookie value after OT login>"
)
```

**Updating persisted query hashes:** OpenTable uses GraphQL persisted queries identified by sha256 hashes. These change when OT deploys new frontend code. If searches start failing with "hash expired" errors, extract fresh hashes from OT's network traffic and pass them:
```
set_opentable_session(
  cookies: "...",
  csrf_token: "...",
  hashes: {"Autocomplete": "<new-hash>", "RestaurantsAvailability": "<new-hash>"}
)
```

## Booking Flow

### 1. Search

```
search_restaurants(name: "Odd Duck", location: "Austin", date: "2026-04-04", party_size: 2)
```

Returns restaurants from both Resy and OpenTable with IDs like `resy-136` or `opentable-31468`.

### 2. Check Availability

```
check_availability(restaurant_id: "resy-136", date: "2026-04-04", party_size: 2)
```

Returns time slots. For Resy, each slot has a `token` field (the `rgs://` config token). For OpenTable, each slot has a `slotId` (the slotHash) and `token` (the slotAvailabilityToken).

### 3. Book

**Resy:**
```
make_reservation(
  slot_token: "rgs://resy/136/2973287/2/2026-04-04/2026-04-04/17:30:00/2/Dining Room",
  date: "2026-04-04",
  party_size: 2
)
```

**OpenTable:**
```
make_reservation(
  platform: "opentable",
  restaurant_id: "opentable-31468",
  slot_token: "<slotHash from availability>",
  slot_availability_token: "<slotAvailabilityToken from availability>",
  date: "2026-04-04",
  party_size: 2
)
```

## One-Shot Booking

```
find_table(restaurant: "Odd Duck", location: "Austin", date: "2026-04-04", time: "6pm", party_size: 2, book: true)
```

Searches, checks availability, and books the best matching slot in one call.

## All Tools

| Tool | Description |
|------|-------------|
| `find_table` | One-shot: search, check availability, and book |
| `search_restaurants` | Search by name/location across Resy and OpenTable |
| `check_availability` | Get available time slots |
| `get_booking_options` | Get book token and payment methods for a Resy slot |
| `make_reservation` | Book via Resy (default) or OpenTable (pass `platform: "opentable"`) |
| `set_opentable_session` | Inject browser cookies + CSRF for OpenTable access |
| `list_reservations` | View upcoming Resy reservations |
| `cancel_reservation` | Cancel a Resy booking |
| `set_credentials` | Store API key/token |
| `set_login` | Store email/password for auto-refresh |
| `check_auth_status` | Verify credentials |
| `refresh_token` | Manually refresh Resy auth token |
| `get_platform_status` | Check platform health and rate limits |
| `snipe_reservation` | Schedule auto-booking |
| `list_snipes` | View scheduled snipes |
| `cancel_snipe` | Cancel a scheduled snipe |

## Architecture

- `dist/index.js` -- Single entry point (stdio transport). Hand-maintained, not compiled from TypeScript.
- `dist/platforms/resy.js` -- Resy client: search, availability, booking via unofficial REST API (axios)
- `dist/platforms/opentable.js` -- OpenTable client: search, availability, booking via GraphQL persisted queries ([impit](https://github.com/apify/impit) for TLS fingerprint spoofing)
- `dist/platforms/tock.js` -- Stub (Tock has no public API)
- `src/` -- TypeScript source (reference; not auto-compiled to dist)

## Security

- No credit card data handled; bookings use payment methods saved in your Resy/OpenTable account
- Credentials encrypted at rest via `~/.restaurant-mcp/credentials.enc` (AES-256-GCM)
- Environment variables take precedence over stored credentials
- HTTPS only, rate-limited (20 req/min Resy, 30 req/min OpenTable)

## Limitations

- Uses unofficial APIs (Resy REST, OpenTable GraphQL) that could change
- OpenTable requires browser session cookies that expire periodically
- OpenTable persisted query hashes change on OT deploys and need manual updating
- Tock has no public API and is not supported
- For personal use only
