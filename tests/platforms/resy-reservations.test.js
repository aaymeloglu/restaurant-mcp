import { describe, it, expect, vi, afterEach } from 'vitest';
import { resyClient } from '../../dist/platforms/resy.js';

// Shape captured from a live /3/user/reservations response (2026-09): reservations are
// flat, venues live in a separate map keyed by venue ID.
const sample = {
  reservations: [
    {
      resy_token: 'tok-1',
      reservation_id: 858861264,
      day: '2026-04-04',
      time_slot: '17:30:00',
      num_seats: 2,
      status: { finished: 1, no_show: 0 },
      venue: { id: 136, currency: 'USD' },
      cancellation: { allowed: false },
    },
    {
      resy_token: 'tok-2',
      reservation_id: 999,
      day: '2026-12-01',
      time_slot: '19:00:00',
      num_seats: 4,
      status: { finished: 0, no_show: 0 },
      venue: { id: 7966, currency: 'USD' },
      cancellation: { allowed: true },
    },
    {
      resy_token: 'tok-3',
      reservation_id: 1000,
      day: '2026-01-01',
      time_slot: '20:00:00',
      num_seats: 2,
      status: { finished: 1, no_show: 1 },
      venue: { id: 424242 },
    },
  ],
  venues: {
    '136': { name: 'Odd Duck', location: { locality: 'Austin', region: 'TX', neighborhood: 'South Lamar' } },
    '7966': { name: 'Uchi', location: { locality: 'Austin', region: 'TX' } },
  },
  metadata: { total: 3, offset: 0, limit: 20 },
};

describe('ResyPlatformClient.getReservations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the flat reservation shape and joins venues by ID', async () => {
    vi.spyOn(resyClient, 'request').mockResolvedValue(sample);
    const result = await resyClient.getReservations();
    expect(result).toEqual([
      {
        reservationId: 'tok-1', reservationNumber: 858861264,
        venue: { name: 'Odd Duck', location: 'South Lamar, Austin, TX' },
        date: '2026-04-04', time: '17:30', partySize: 2, status: 'finished', cancellable: false,
      },
      {
        reservationId: 'tok-2', reservationNumber: 999,
        venue: { name: 'Uchi', location: 'Austin, TX' },
        date: '2026-12-01', time: '19:00', partySize: 4, status: 'upcoming', cancellable: true,
      },
      {
        reservationId: 'tok-3', reservationNumber: 1000,
        venue: { name: '', location: '' },
        date: '2026-01-01', time: '20:00', partySize: 2, status: 'no_show', cancellable: false,
      },
    ]);
  });

  it('returns an empty list when the response has no reservations', async () => {
    vi.spyOn(resyClient, 'request').mockResolvedValue({ venues: {}, metadata: {} });
    expect(await resyClient.getReservations()).toEqual([]);
  });
});

describe('ResyPlatformClient.cancelReservation', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockRequest() {
    return vi.spyOn(resyClient, 'request').mockImplementation(async (method, url) => {
      if (method === 'get' && url === '/3/user/reservations') return sample;
      if (method === 'post' && url === '/3/cancel') return {};
      throw new Error(`unexpected request ${method} ${url}`);
    });
  }

  it('POSTs the resy_token to /3/cancel', async () => {
    const request = mockRequest();
    await resyClient.cancelReservation('tok-2');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('post', '/3/cancel', { resy_token: 'tok-2' });
  });

  it('resolves a numeric confirmation number to its resy_token first', async () => {
    const request = mockRequest();
    await resyClient.cancelReservation('999');
    expect(request).toHaveBeenNthCalledWith(1, 'get', '/3/user/reservations');
    expect(request).toHaveBeenNthCalledWith(2, 'post', '/3/cancel', { resy_token: 'tok-2' });
  });

  it('throws a clear error for an unknown confirmation number', async () => {
    const request = mockRequest();
    await expect(resyClient.cancelReservation('424242')).rejects.toThrow(/424242/);
    expect(request).not.toHaveBeenCalledWith('post', '/3/cancel', expect.anything());
  });
});
