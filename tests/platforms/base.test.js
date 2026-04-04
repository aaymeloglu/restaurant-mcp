import { describe, it, expect } from 'vitest';
import {
  createRestaurantId,
  parseRestaurantId,
  BasePlatformClient,
} from '../../dist/platforms/base.js';

// Concrete subclass for testing BasePlatformClient
class TestClient extends BasePlatformClient {
  constructor() {
    super();
    this.name = 'resy';
  }
  async searchRestaurants() { return []; }
  async getRestaurant() { return null; }
  async getAvailability() { return []; }
  async makeReservation() { return null; }
  async cancelReservation() { return false; }
  async getReservations() { return []; }
}

describe('createRestaurantId', () => {
  it('creates a resy ID', () => {
    expect(createRestaurantId('resy', '12345')).toBe('resy-12345');
  });

  it('creates an opentable ID', () => {
    expect(createRestaurantId('opentable', '67890')).toBe('opentable-67890');
  });

  it('creates a tock ID', () => {
    expect(createRestaurantId('tock', 'abc')).toBe('tock-abc');
  });
});

describe('parseRestaurantId', () => {
  it('parses a valid resy ID', () => {
    expect(parseRestaurantId('resy-12345')).toEqual({ platform: 'resy', id: '12345' });
  });

  it('parses a valid opentable ID', () => {
    expect(parseRestaurantId('opentable-67890')).toEqual({ platform: 'opentable', id: '67890' });
  });

  it('parses a valid tock ID', () => {
    expect(parseRestaurantId('tock-abc')).toEqual({ platform: 'tock', id: 'abc' });
  });

  it('returns null for unknown platform', () => {
    expect(parseRestaurantId('yelp-12345')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseRestaurantId('noprefixhere')).toBeNull();
  });
});

describe('BasePlatformClient', () => {
  const client = new TestClient();

  it('createId prefixes with platform name', () => {
    expect(client.createId('999')).toBe('resy-999');
  });

  it('extractId strips the platform prefix', () => {
    expect(client.extractId('resy-999')).toBe('999');
  });

  it('extractId returns the raw ID when prefix does not match', () => {
    expect(client.extractId('opentable-999')).toBe('opentable-999');
  });

  it('today returns a YYYY-MM-DD string', () => {
    const result = client.today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formatTime handles 24-hour format', () => {
    expect(client.formatTime('18:30')).toBe('18:30');
  });

  it('formatTime handles 12-hour PM format', () => {
    expect(client.formatTime('12:30 PM')).toBe('12:30');
  });

  it('formatTime handles 12:00 AM as midnight', () => {
    expect(client.formatTime('12:00 AM')).toBe('00:00');
  });

  it('formatTime handles 7:00 PM', () => {
    expect(client.formatTime('7:00 PM')).toBe('19:00');
  });
});
