# OpenTable GraphQL Integration Design

**Goal:** Add OpenTable search, availability, and booking to the restaurant-mcp server via OpenTable's internal GraphQL API, with SMS-based auth for booking.

## Search (no auth)

Hit `https://www.opentable.com/dapi/fe/gql?optype=query&opname=Autocomplete` with persisted query hash. Input: restaurant name, lat/long, covers. Returns OT restaurant IDs, names, neighborhoods, cuisine. Runs in parallel with Resy search in existing `searchRestaurant()` flow.

## Availability (no auth)

Hit same GraphQL endpoint with `RestaurantsAvailability` operation. Input: OT restaurant ID(s), date, time, party size. Returns time slots with `slotHash` and `slotAvailabilityToken` needed for booking.

## Booking (auth required)

Hit `https://www.opentable.com/dapi/booking/make-reservation` with `authCke` cookie + slot tokens from availability check. If no cookie stored, trigger Playwright SMS login flow: navigate to opentable.com login, enter phone number, read SMS code from Google Messages for Web, submit, extract cookie. Store cookie in credentials.enc for reuse.

## Persisted Query Hashes

Store sha256 hashes as constants in the OT client. Known working hashes from open-source repos:
- `Autocomplete`: `3cabca79abcb0db395d3cbebb4d47d41f3ddd69442eba3a57f76b943cceb8cf4`
- `RestaurantsAvailability`: `55b189ad974cc410bc3c3806dfba757011866babcb67a9a8a9c86464b46e587c`

When OT deploys and hashes break (PersistedQueryNotFound error), log a warning. Future enhancement: auto-scrape fresh hashes from OT's JS bundles.

## Credential Storage

- `opentable-auth-cookie` -- the authCke value
- `opentable-phone` -- phone number for re-auth
- Same encrypted storage as Resy credentials, env var override via `OPENTABLE_AUTH_COOKIE`

## Error Handling

- Hash mismatch (PersistedQueryNotFound): surface error, hashes need manual update
- Auth expired on booking: re-run Playwright SMS login automatically
- Rate limiting: existing 30 req/min bucket for opentable
