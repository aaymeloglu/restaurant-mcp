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
