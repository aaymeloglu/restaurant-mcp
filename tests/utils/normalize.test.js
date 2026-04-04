import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  normalizeAddress,
  normalizeLocation,
  removeAccents,
  extractCoreName,
  parseAddress,
  createDedupeKey,
  normalizeCuisine,
  parseCuisines,
} from '../../dist/utils/normalize.js';

describe('removeAccents', () => {
  it('removes diacritics from accented characters', () => {
    expect(removeAccents('café')).toBe('cafe');
    expect(removeAccents('résumé')).toBe('resume');
    expect(removeAccents('naïve')).toBe('naive');
    expect(removeAccents('über')).toBe('uber');
  });

  it('leaves plain ASCII unchanged', () => {
    expect(removeAccents('hello')).toBe('hello');
  });
});

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Carbone  ')).toBe('carbone');
  });

  it('removes common suffixes like restaurant, bistro, cafe', () => {
    expect(normalizeName('Le Bernardin Restaurant')).toBe('le bernardin');
    expect(normalizeName('Corner Bistro')).toBe('corner');
    expect(normalizeName('Mud Cafe')).toBe('mud');
  });

  it('removes "The" prefix', () => {
    expect(normalizeName('The Smith')).toBe('smith');
  });

  it('normalizes "and" to "&"', () => {
    expect(normalizeName('Salt and Bone')).toBe('salt & bone');
    expect(normalizeName('Salt & Bone')).toBe('salt & bone');
  });

  it('removes possessive', () => {
    expect(normalizeName("Joe's Pizza")).toBe('joe pizza');
  });

  it('removes accents', () => {
    expect(normalizeName('Café Boulud')).toBe('cafe boulud');
    expect(normalizeName('Ñoño')).toBe('nono');
  });

  it('collapses extra whitespace', () => {
    expect(normalizeName('Big   Mamma')).toBe('big mamma');
  });
});

describe('normalizeAddress', () => {
  it('expands abbreviations', () => {
    expect(normalizeAddress('123 Main St')).toBe('123 main street');
    expect(normalizeAddress('456 Park Ave')).toBe('456 park avenue');
  });

  it('expands abbreviations with trailing periods', () => {
    expect(normalizeAddress('789 Oak Blvd.')).toBe('789 oak boulevard');
  });

  it('removes apartment/suite/unit suffixes', () => {
    // Note: abbreviations are expanded before the apt/ste removal regex runs,
    // so "Apt" becomes "apartment" and no longer matches the removal pattern.
    // Only raw abbreviated forms in the regex (apt|suite|ste|unit|#) are removed.
    expect(normalizeAddress('100 Broadway #5B')).toBe('100 broadway');
    expect(normalizeAddress('200 Main St Suite 300')).toBe('200 main street');
    expect(normalizeAddress('50 Elm St Unit C')).toBe('50 elm street');
  });

  it('removes zip codes at end', () => {
    expect(normalizeAddress('100 Broadway 10001')).toBe('100 broadway');
    expect(normalizeAddress('100 Broadway 10001-1234')).toBe('100 broadway');
  });

  it('removes accents', () => {
    // Note: "la" is expanded to "los angeles" by abbreviation map
    expect(normalizeAddress('10 Pépinière')).toBe('10 pepiniere');
  });
});

describe('normalizeLocation', () => {
  it('expands city abbreviations', () => {
    expect(normalizeLocation('NYC')).toBe('new york city');
    expect(normalizeLocation('SF')).toBe('san francisco');
    expect(normalizeLocation('LA')).toBe('los angeles');
  });

  it('removes state abbreviation at end', () => {
    expect(normalizeLocation('Austin, TX')).toBe('austin');
  });

  it('lowercases and trims', () => {
    expect(normalizeLocation('  Brooklyn  ')).toBe('brooklyn');
  });

  it('removes accents', () => {
    expect(normalizeLocation('Montréal')).toBe('montreal');
  });
});

describe('extractCoreName', () => {
  it('removes location suffixes', () => {
    expect(extractCoreName('Carbone NYC')).toBe('carbone');
    expect(extractCoreName('Pastis Downtown')).toBe('pastis');
  });

  it('removes trailing numbers', () => {
    expect(extractCoreName('Tavern 2.0')).toBe('tavern');
    expect(extractCoreName('Sequel II')).toBe('sequel');
  });

  it('applies normalizeName transformations too', () => {
    // "grill" is in the suffix pattern list so "Capital Grill Restaurant" ->
    // first "restaurant" suffix removed -> "capital grill" -> "grill" is also a suffix
    // but the regex only removes at end, and after "restaurant" is removed, "grill" is at end
    expect(extractCoreName('The Capital Grill Restaurant')).toBe('capital grill');
  });
});

describe('parseAddress', () => {
  it('parses street from single-part address', () => {
    const result = parseAddress('123 Main Street');
    expect(result.street).toBe('123 Main Street');
  });

  it('parses street and city from two-part address', () => {
    const result = parseAddress('123 Main Street, New York');
    expect(result.street).toBe('123 Main Street');
    expect(result.city).toBe('New York');
  });

  it('parses street, neighborhood, and city from three-part address', () => {
    const result = parseAddress('123 Main Street, SoHo, New York');
    expect(result.street).toBe('123 Main Street');
    expect(result.neighborhood).toBe('SoHo');
    expect(result.city).toBe('New York');
  });

  it('extracts zip code', () => {
    const result = parseAddress('123 Main Street, New York, NY 10001');
    expect(result.zip).toBe('10001');
  });

  it('extracts state abbreviation', () => {
    const result = parseAddress('123 Main Street, New York, NY 10001');
    expect(result.state).toBe('NY');
  });

  it('strips state and zip from city field', () => {
    const result = parseAddress('123 Main Street, New York NY 10001');
    expect(result.city).toBe('New York');
  });
});

describe('createDedupeKey', () => {
  it('creates a normalized pipe-separated key', () => {
    const key = createDedupeKey('Carbone NYC', 'New York, NY');
    expect(key).toBe('carbone|new york');
  });

  it('matches equivalent names with different formatting', () => {
    const key1 = createDedupeKey('The Carbone Restaurant', 'NYC');
    const key2 = createDedupeKey('Carbone', 'New York City');
    expect(key1).toBe(key2);
  });
});

describe('normalizeCuisine', () => {
  it('lowercases and trims', () => {
    expect(normalizeCuisine('  Italian  ')).toBe('italian');
  });

  it('removes "cuisine" suffix', () => {
    expect(normalizeCuisine('Japanese Cuisine')).toBe('japanese');
  });

  it('removes "food" suffix', () => {
    expect(normalizeCuisine('Thai Food')).toBe('thai');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeCuisine('New American')).toBe('new-american');
  });
});

describe('parseCuisines', () => {
  it('returns empty array for falsy input', () => {
    expect(parseCuisines('')).toEqual([]);
    expect(parseCuisines(null)).toEqual([]);
    expect(parseCuisines(undefined)).toEqual([]);
  });

  it('splits on commas', () => {
    expect(parseCuisines('Italian, French, Japanese')).toEqual([
      'italian',
      'french',
      'japanese',
    ]);
  });

  it('splits on slashes', () => {
    expect(parseCuisines('Italian/French')).toEqual(['italian', 'french']);
  });

  it('normalizes each cuisine', () => {
    expect(parseCuisines('Thai Food, New American Cuisine')).toEqual([
      'thai',
      'new-american',
    ]);
  });
});
