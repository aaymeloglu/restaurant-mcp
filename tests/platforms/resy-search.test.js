import { describe, it, expect, vi, afterEach } from 'vitest';
import { resyClient } from '../../dist/platforms/resy.js';

// Hits trimmed from a live /3/venuesearch/search response for "Odd Duck" near Austin (2026-10).
// Pecan Square Cafe comes back from Resy's typo-tolerant index despite the name not matching.
const hits = [
  {
    id: { resy: 136 }, name: 'Odd Duck', locality: 'Austin', region: 'TX', neighborhood: 'South Lamar',
    location: { name: 'Austin' }, cuisine: ['American'], price_range_id: 2,
    rating: { average: 4.85, count: 26791 }, images: ['https://image.resy.com/odd-duck.jpg'],
  },
  {
    id: { resy: 99639 }, name: 'Pecan Square Cafe', locality: 'Austin', region: 'TX',
    neighborhood: 'Old West Austin', location: { name: 'Austin' }, cuisine: ['Contemporary American'],
    price_range_id: 1, rating: { average: 5, count: 24 },
  },
];

describe('ResyPlatformClient.search', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockSearch() {
    vi.spyOn(resyClient, 'ensureCredentials').mockResolvedValue(undefined);
    return vi.spyOn(resyClient.client, 'post').mockResolvedValue({ data: { search: { hits } } });
  }

  it('sends the name query to venuesearch, scoped to the city', async () => {
    const post = mockSearch();
    await resyClient.search({ query: 'Odd Duck', location: 'Austin, TX', date: '2026-11-07', partySize: 2 });
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/3/venuesearch/search');
    expect(body.query).toBe('Odd Duck');
    expect(body.types).toEqual(['venue']);
    expect(body.geo).toMatchObject({ latitude: 30.2672, longitude: -97.7431 });
    expect(body.geo.radius).toBeGreaterThan(0);
  });

  it('drops hits whose names do not match the query', async () => {
    mockSearch();
    const results = await resyClient.search({ query: 'Odd Duck', location: 'Austin, TX' });
    expect(results).toEqual([
      {
        id: 'resy-136', platform: 'resy', platformId: 136, name: 'Odd Duck',
        location: 'Austin, TX', neighborhood: 'South Lamar', cuisine: 'American', cuisines: ['American'],
        priceRange: 2, rating: 4.85, reviewCount: 26791, imageUrl: 'https://image.resy.com/odd-duck.jpg',
      },
    ]);
  });

  it('tolerates small typos in the query', async () => {
    mockSearch();
    const results = await resyClient.search({ query: 'odd duk', location: 'Austin, TX' });
    expect(results.map((r) => r.name)).toEqual(['Odd Duck']);
  });
});
