import { describe, it, expect } from 'vitest';
import {
  levenshteinDistance,
  tokenize,
  jaccardSimilarity,
  containsTokens,
  fuzzyMatch,
  findBestMatches,
  isSameRestaurant,
} from '../../dist/utils/fuzzy.js';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('handles single character difference', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('handles insertions and deletions', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('handles completely different strings', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3);
  });
});

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    expect(tokenize('The Grill at the Park')).toEqual(['grill', 'park']);
  });

  it('removes punctuation', () => {
    expect(tokenize("Joe's Crab Shack")).toEqual(['crab', 'joe', 's', 'shack']);
  });

  it('removes & as stop word', () => {
    expect(tokenize('Salt & Pepper')).toEqual(['pepper', 'salt']);
  });

  it('sorts tokens alphabetically', () => {
    expect(tokenize('Zebra Alpha')).toEqual(['alpha', 'zebra']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('filters out empty tokens from multiple spaces', () => {
    expect(tokenize('  hello   world  ')).toEqual(['hello', 'world']);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical token sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns 1 for two empty arrays', () => {
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it('returns 0 when one array is empty', () => {
    expect(jaccardSimilarity(['a'], [])).toBe(0);
    expect(jaccardSimilarity([], ['a'])).toBe(0);
  });

  it('calculates partial overlap correctly', () => {
    // intersection=1 (b), union=3 (a,b,c)
    expect(jaccardSimilarity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('handles duplicate tokens via Set dedup', () => {
    // Sets: {a,b} and {a,b} => 1
    expect(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
  });
});

describe('containsTokens', () => {
  it('returns true when all needle tokens are in haystack', () => {
    expect(containsTokens(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
  });

  it('returns false when some needle tokens are missing', () => {
    expect(containsTokens(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('returns true for empty needle', () => {
    expect(containsTokens(['a', 'b'], [])).toBe(true);
  });

  it('returns false when haystack is empty but needle is not', () => {
    expect(containsTokens([], ['a'])).toBe(false);
  });
});

describe('fuzzyMatch', () => {
  it('returns score 1.0 for exact match', () => {
    const result = fuzzyMatch('Uchi', 'Uchi');
    expect(result.score).toBe(1.0);
    expect(result.matchType).toBe('exact');
  });

  it('returns score 0.95 for case-insensitive match', () => {
    const result = fuzzyMatch('uchi', 'Uchi');
    expect(result.score).toBe(0.95);
    expect(result.matchType).toBe('case-insensitive');
  });

  it('returns score 0.9 for token-reorder match', () => {
    // "The Grill" and "Grill The" after stop word removal both become ["grill"]
    // Need tokens that reorder but aren't stop words
    const result = fuzzyMatch('Bravo Alpha', 'Alpha Bravo');
    expect(result.score).toBe(0.9);
    expect(result.matchType).toBe('token-reorder');
  });

  it('handles fuzzy match for small typos', () => {
    const result = fuzzyMatch('Uchiko', 'Uchik');
    expect(result.matchType).toBe('fuzzy');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.score).toBeLessThanOrEqual(0.85);
  });

  it('handles contains match when query is in target', () => {
    const result = fuzzyMatch('Grill', 'The Capital Grille');
    // After lowering: "grill" is not in "the capital grille" (different spelling)
    // Let's use a real substring
    const result2 = fuzzyMatch('Capital', 'The Capital Grille');
    expect(result2.matchType).toBe('contains');
    expect(result2.score).toBeGreaterThanOrEqual(0.5);
  });

  it('handles contains match when target is in query', () => {
    const result = fuzzyMatch('The Capital Grille Downtown', 'Capital');
    expect(result.matchType).toBe('contains');
    expect(result.score).toBeGreaterThanOrEqual(0.4);
  });

  it('handles token contains match', () => {
    // query tokens all found in target tokens, but not a substring match
    const result = fuzzyMatch('Blue Fish', 'Blue Fin Fish Market');
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('returns no-match for completely different strings', () => {
    const result = fuzzyMatch('Uchi', 'McDonalds');
    expect(result.score).toBe(0);
    expect(result.matchType).toBe('no-match');
  });

  it('trims whitespace before comparison', () => {
    const result = fuzzyMatch('  Uchi  ', 'Uchi');
    expect(result.score).toBe(1.0);
  });
});

describe('findBestMatches', () => {
  const targets = ['Uchi', 'Uchiko', 'McDonalds', 'Uchi Austin', 'Sushi'];

  it('returns exact match first', () => {
    const matches = findBestMatches('Uchi', targets);
    expect(matches[0].target).toBe('Uchi');
    expect(matches[0].result.score).toBe(1.0);
  });

  it('respects minScore option', () => {
    const matches = findBestMatches('Uchi', targets, { minScore: 0.9 });
    for (const m of matches) {
      expect(m.result.score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('respects limit option', () => {
    const matches = findBestMatches('Uchi', targets, { limit: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('sorts by score descending', () => {
    const matches = findBestMatches('Uchi', targets);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].result.score).toBeLessThanOrEqual(matches[i - 1].result.score);
    }
  });

  it('includes index property', () => {
    const matches = findBestMatches('Uchi', targets);
    const exact = matches.find(m => m.target === 'Uchi');
    expect(exact.index).toBe(0);
  });

  it('uses default minScore of 0.3 and limit of 10', () => {
    const matches = findBestMatches('Uchi', targets);
    for (const m of matches) {
      expect(m.result.score).toBeGreaterThanOrEqual(0.3);
    }
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

describe('isSameRestaurant', () => {
  it('returns true for strong name match (>= 0.85)', () => {
    expect(isSameRestaurant('Uchi', 'Uchi')).toBe(true);
  });

  it('returns true for case-insensitive name match', () => {
    expect(isSameRestaurant('uchi', 'Uchi')).toBe(true);
  });

  it('returns false for weak name match without location', () => {
    expect(isSameRestaurant('Blue', 'Blue Fin Fish Market')).toBe(false);
  });

  it('returns true for moderate name match with matching location', () => {
    // fuzzyMatch('Sushi Bar', 'Sushi Bar & Grill') should be >= 0.6 (token contains)
    // and location match >= 0.7
    expect(isSameRestaurant('Sushi Bar', 'Sushi Bar Grill', 'Austin TX', 'Austin TX')).toBe(true);
  });

  it('returns false for moderate name match with different location', () => {
    expect(isSameRestaurant('Sushi Bar', 'Sushi Bar Grill', 'Austin TX', 'New York NY')).toBe(false);
  });

  it('returns false for completely different names', () => {
    expect(isSameRestaurant('Uchi', 'McDonalds')).toBe(false);
  });
});
