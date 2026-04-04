# Test Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add unit tests and CI for the restaurant-mcp server, covering all pure utility code and key service logic.

**Architecture:** Use vitest (fast, ESM-native, no config needed for this project). Test the pure utility modules first (fuzzy, normalize, cache, rate-limiter, base), then the Resy platform client with mocked HTTP. CI via GitHub Actions on push/PR.

**Tech Stack:** vitest, GitHub Actions

---

### Task 1: Install vitest and add test script

**Files:**
- Modify: `package.json`

**Step 1: Install vitest**

Run: `npm install --save-dev vitest@3.1.1`

**Step 2: Add test script to package.json**

Add to `scripts`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 3: Verify vitest runs (no tests yet)**

Run: `npx vitest run`
Expected: "No test files found"

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest for testing"
```

---

### Task 2: Test fuzzy matching utilities

**Files:**
- Create: `tests/utils/fuzzy.test.js`
- Test target: `dist/utils/fuzzy.js`

**Step 1: Write tests**

```js
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

  it('counts single character edits', () => {
    expect(levenshteinDistance('cat', 'car')).toBe(1);
    expect(levenshteinDistance('cat', 'cats')).toBe(1);
  });
});

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('Odd Duck')).toEqual(['duck', 'odd']);
  });

  it('removes stop words', () => {
    expect(tokenize('The Grill at the Park')).toEqual(['grill', 'park']);
  });

  it('removes punctuation', () => {
    expect(tokenize("Carbone's Bar & Grill")).toEqual(['bar', 'carbone', 'grill']);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a'], ['b'])).toBe(0);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccardSimilarity([], [])).toBe(1);
  });
});

describe('containsTokens', () => {
  it('returns true when all needle tokens are in haystack', () => {
    expect(containsTokens(['odd', 'duck', 'austin'], ['odd', 'duck'])).toBe(true);
  });

  it('returns false when needle has tokens not in haystack', () => {
    expect(containsTokens(['odd', 'duck'], ['odd', 'duck', 'austin'])).toBe(false);
  });

  it('returns true for empty needle', () => {
    expect(containsTokens(['a'], [])).toBe(true);
  });
});

describe('fuzzyMatch', () => {
  it('scores exact match as 1.0', () => {
    const result = fuzzyMatch('Odd Duck', 'Odd Duck');
    expect(result.score).toBe(1.0);
    expect(result.matchType).toBe('exact');
  });

  it('scores case-insensitive match as 0.95', () => {
    const result = fuzzyMatch('odd duck', 'Odd Duck');
    expect(result.score).toBe(0.95);
  });

  it('scores contains match when query is substring of target', () => {
    const result = fuzzyMatch('Duck', 'Odd Duck');
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.matchType).toBe('contains');
  });

  it('returns 0 for completely unrelated strings', () => {
    const result = fuzzyMatch('Pizza Hut', 'Odd Duck');
    expect(result.score).toBe(0);
  });
});

describe('findBestMatches', () => {
  const targets = ['Odd Duck', 'Uchi Austin', 'Lenoir', 'Launderette'];

  it('returns exact match first', () => {
    const matches = findBestMatches('Odd Duck', targets);
    expect(matches[0].target).toBe('Odd Duck');
  });

  it('respects minScore filter', () => {
    const matches = findBestMatches('xyz', targets, { minScore: 0.5 });
    expect(matches).toHaveLength(0);
  });

  it('respects limit', () => {
    const matches = findBestMatches('u', targets, { minScore: 0, limit: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});

describe('isSameRestaurant', () => {
  it('matches identical names', () => {
    expect(isSameRestaurant('Odd Duck', 'Odd Duck')).toBe(true);
  });

  it('matches with location when name is moderate match', () => {
    expect(isSameRestaurant('Uchi', 'Uchi Austin', 'Austin', 'Austin, TX')).toBe(true);
  });

  it('rejects completely different restaurants', () => {
    expect(isSameRestaurant('Odd Duck', 'Uchi Austin')).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/utils/fuzzy.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: add fuzzy matching utility tests"
```

---

### Task 3: Test normalization utilities

**Files:**
- Create: `tests/utils/normalize.test.js`
- Test target: `dist/utils/normalize.js`

**Step 1: Write tests**

```js
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

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Odd Duck  ')).toBe('odd duck');
  });

  it('removes common suffixes like Restaurant', () => {
    expect(normalizeName('Vespaio Restaurant')).toBe('vespaio');
  });

  it('normalizes "and" to "&"', () => {
    expect(normalizeName('Lin Asian Bar and Dim Sum')).toBe('lin asian bar & dim sum');
  });

  it('removes possessives', () => {
    expect(normalizeName("Jack Allen's Kitchen")).toBe('jack allen');
  });

  it('removes leading "The"', () => {
    expect(normalizeName('The Grove Wine Bar')).toBe('grove wine bar');
  });

  it('removes accents', () => {
    expect(normalizeName('Peche Austin')).toBe('peche austin');
    expect(normalizeName('Peche\u0301 Austin')).toBe('peche austin');
  });
});

describe('normalizeAddress', () => {
  it('expands abbreviations', () => {
    expect(normalizeAddress('123 Main St')).toBe('123 main street');
  });

  it('removes suite numbers', () => {
    expect(normalizeAddress('800 W Cesar Chavez St Ste PP110')).toContain('800');
    expect(normalizeAddress('800 W Cesar Chavez St Ste PP110')).not.toContain('pp110');
  });

  it('removes zip codes', () => {
    expect(normalizeAddress('Austin TX 78701')).not.toContain('78701');
  });
});

describe('normalizeLocation', () => {
  it('expands city abbreviations', () => {
    expect(normalizeLocation('NYC')).toBe('new york city');
    expect(normalizeLocation('SF')).toBe('san francisco');
  });

  it('removes state abbreviation at end', () => {
    expect(normalizeLocation('Austin, TX')).toBe('austin');
  });
});

describe('removeAccents', () => {
  it('strips diacritics', () => {
    expect(removeAccents('cafe\u0301')).toBe('cafe');
    expect(removeAccents('naive\u0308')).toBe('naive');
  });

  it('leaves plain ASCII unchanged', () => {
    expect(removeAccents('hello')).toBe('hello');
  });
});

describe('extractCoreName', () => {
  it('strips location suffixes', () => {
    expect(extractCoreName('Uchi Austin')).toBe('uchi');
  });

  it('strips roman numerals', () => {
    expect(extractCoreName('III Forks')).toBe('forks');
  });
});

describe('parseAddress', () => {
  it('extracts zip code', () => {
    const parsed = parseAddress('800 W Cesar Chavez St, Austin, TX 78701');
    expect(parsed.zip).toBe('78701');
  });

  it('extracts state', () => {
    const parsed = parseAddress('800 W Cesar Chavez St, Austin, TX 78701');
    expect(parsed.state).toBe('TX');
  });

  it('extracts street', () => {
    const parsed = parseAddress('800 W Cesar Chavez St, Austin, TX 78701');
    expect(parsed.street).toBe('800 W Cesar Chavez St');
  });
});

describe('createDedupeKey', () => {
  it('normalizes both name and city', () => {
    const key = createDedupeKey('Uchi Austin', 'Austin, TX');
    expect(key).toBe('uchi|austin');
  });
});

describe('normalizeCuisine', () => {
  it('lowercases and strips "cuisine" suffix', () => {
    expect(normalizeCuisine('Italian Cuisine')).toBe('italian');
  });

  it('strips "food" suffix', () => {
    expect(normalizeCuisine('Thai Food')).toBe('thai');
  });
});

describe('parseCuisines', () => {
  it('splits on comma and normalizes', () => {
    expect(parseCuisines('Italian, Mexican')).toEqual(['italian', 'mexican']);
  });

  it('returns empty array for empty input', () => {
    expect(parseCuisines('')).toEqual([]);
    expect(parseCuisines(undefined)).toEqual([]);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/utils/normalize.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: add normalization utility tests"
```

---

### Task 4: Test cache service

**Files:**
- Create: `tests/services/cache.test.js`
- Test target: `dist/services/cache.js`

**Step 1: Write tests**

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService, CacheKeys, hashSearchQuery } from '../../dist/services/cache.js';

describe('CacheService', () => {
  let cache;

  beforeEach(() => {
    cache = new CacheService();
  });

  afterEach(() => {
    cache.destroy();
  });

  it('returns null for missing keys', () => {
    expect(cache.get('missing')).toBeNull();
  });

  it('stores and retrieves values', () => {
    cache.set('key', 'value', 60000);
    expect(cache.get('key')).toBe('value');
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    cache.set('key', 'value', 1000);
    expect(cache.get('key')).toBe('value');

    vi.advanceTimersByTime(1001);
    expect(cache.get('key')).toBeNull();
    vi.useRealTimers();
  });

  it('tracks hit/miss stats', () => {
    cache.set('key', 'value', 60000);
    cache.get('key');    // hit
    cache.get('key');    // hit
    cache.get('nope');   // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('has() returns false for expired entries', () => {
    vi.useFakeTimers();
    cache.set('key', 'value', 500);
    expect(cache.has('key')).toBe(true);

    vi.advanceTimersByTime(501);
    expect(cache.has('key')).toBe(false);
    vi.useRealTimers();
  });

  it('invalidate() removes matching keys', () => {
    cache.set('availability:resy:1:2026-04-04:2', 'data1', 60000);
    cache.set('availability:resy:2:2026-04-04:2', 'data2', 60000);
    cache.set('health:resy', true, 60000);

    const count = cache.invalidate('availability:resy:*');
    expect(count).toBe(2);
    expect(cache.get('health:resy')).toBe(true);
  });

  it('clear() resets everything', () => {
    cache.set('a', 1, 60000);
    cache.set('b', 2, 60000);
    cache.get('a');
    cache.clear();

    expect(cache.stats().size).toBe(0);
    expect(cache.stats().hits).toBe(0);
  });

  it('delete() removes a specific key', () => {
    cache.set('key', 'val', 60000);
    expect(cache.delete('key')).toBe(true);
    expect(cache.get('key')).toBeNull();
  });
});

describe('CacheKeys', () => {
  it('generates search key', () => {
    expect(CacheKeys.search('abc')).toBe('search:abc');
  });

  it('generates details key', () => {
    expect(CacheKeys.details('resy', 136)).toBe('details:resy:136');
  });

  it('generates availability key', () => {
    expect(CacheKeys.availability('resy', 136, '2026-04-04', 2)).toBe('availability:resy:136:2026-04-04:2');
  });

  it('generates health key', () => {
    expect(CacheKeys.health('resy')).toBe('health:resy');
  });
});

describe('hashSearchQuery', () => {
  it('returns consistent hash for same inputs', () => {
    const h1 = hashSearchQuery('Uchi', 'Austin');
    const h2 = hashSearchQuery('Uchi', 'Austin');
    expect(h1).toBe(h2);
  });

  it('is case-insensitive', () => {
    const h1 = hashSearchQuery('uchi', 'austin');
    const h2 = hashSearchQuery('Uchi', 'Austin');
    expect(h1).toBe(h2);
  });

  it('differentiates different queries', () => {
    const h1 = hashSearchQuery('Uchi', 'Austin');
    const h2 = hashSearchQuery('Odd Duck', 'Austin');
    expect(h1).not.toBe(h2);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/services/cache.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: add cache service tests"
```

---

### Task 5: Test rate limiter

**Files:**
- Create: `tests/services/rate-limiter.test.js`
- Test target: `dist/services/rate-limiter.js`

**Step 1: Write tests**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../dist/services/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows requests within limit', () => {
    expect(limiter.tryAcquire('resy')).toBe(true);
  });

  it('exhausts tokens after max requests', () => {
    // Resy limit is 20
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryAcquire('resy')).toBe(true);
    }
    expect(limiter.tryAcquire('resy')).toBe(false);
  });

  it('reports status correctly', () => {
    limiter.tryAcquire('resy');
    const status = limiter.getStatus('resy');
    expect(status.platform).toBe('resy');
    expect(status.available).toBe(19);
    expect(status.max).toBe(20);
    expect(status.isLimited).toBe(false);
  });

  it('reports limited when tokens exhausted', () => {
    for (let i = 0; i < 20; i++) limiter.tryAcquire('resy');
    const status = limiter.getStatus('resy');
    expect(status.isLimited).toBe(true);
  });

  it('reset() restores tokens', () => {
    for (let i = 0; i < 20; i++) limiter.tryAcquire('resy');
    limiter.reset('resy');
    expect(limiter.tryAcquire('resy')).toBe(true);
  });

  it('getAllStatus() returns all platforms', () => {
    const statuses = limiter.getAllStatus();
    const platforms = statuses.map(s => s.platform);
    expect(platforms).toContain('resy');
    expect(platforms).toContain('opentable');
    expect(platforms).toContain('tock');
  });

  it('uses default limits for unknown platforms', () => {
    expect(limiter.tryAcquire('unknown')).toBe(true);
    const status = limiter.getStatus('unknown');
    expect(status.max).toBe(10);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/services/rate-limiter.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: add rate limiter tests"
```

---

### Task 6: Test platform base utilities

**Files:**
- Create: `tests/platforms/base.test.js`
- Test target: `dist/platforms/base.js`

**Step 1: Write tests**

```js
import { describe, it, expect } from 'vitest';
import { createRestaurantId, parseRestaurantId, BasePlatformClient } from '../../dist/platforms/base.js';

describe('createRestaurantId', () => {
  it('creates prefixed IDs', () => {
    expect(createRestaurantId('resy', 136)).toBe('resy-136');
    expect(createRestaurantId('opentable', 67890)).toBe('opentable-67890');
    expect(createRestaurantId('tock', 'venue-slug')).toBe('tock-venue-slug');
  });
});

describe('parseRestaurantId', () => {
  it('parses resy IDs', () => {
    const result = parseRestaurantId('resy-136');
    expect(result).toEqual({ platform: 'resy', id: '136' });
  });

  it('parses opentable IDs', () => {
    const result = parseRestaurantId('opentable-67890');
    expect(result).toEqual({ platform: 'opentable', id: '67890' });
  });

  it('parses tock IDs with slug', () => {
    const result = parseRestaurantId('tock-odd-duck');
    expect(result).toEqual({ platform: 'tock', id: 'odd-duck' });
  });

  it('returns null for unknown platform', () => {
    expect(parseRestaurantId('unknown-123')).toBeNull();
  });

  it('returns null for malformed ID', () => {
    expect(parseRestaurantId('nope')).toBeNull();
  });
});

describe('BasePlatformClient', () => {
  // Create a concrete subclass for testing
  class TestClient extends BasePlatformClient {
    name = 'resy';
    async search() { return []; }
    async getDetails() { return null; }
    async getAvailability() { return []; }
    async makeReservation() { return { success: false, platform: 'resy' }; }
    async isAvailable() { return true; }
    async isAuthenticated() { return false; }
  }

  const client = new TestClient();

  it('createId prefixes with platform name', () => {
    expect(client.createId(136)).toBe('resy-136');
  });

  it('extractId strips platform prefix', () => {
    expect(client.extractId('resy-136')).toBe('136');
  });

  it('extractId returns raw string if no prefix', () => {
    expect(client.extractId('136')).toBe('136');
  });

  it('today() returns YYYY-MM-DD format', () => {
    const today = client.today();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formatTime handles 24-hour format', () => {
    expect(client.formatTime('17:30')).toBe('17:30');
  });

  it('formatTime handles 12-hour format with AM/PM', () => {
    expect(client.formatTime('5:30 PM')).toBe('17:30');
    expect(client.formatTime('12:00 AM')).toBe('00:00');
    expect(client.formatTime('12:30 PM')).toBe('12:30');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/platforms/base.test.js`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: add platform base utility tests"
```

---

### Task 7: Add GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Step 1: Create workflow**

```yaml
name: Tests

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
```

**Step 2: Run tests locally to confirm all pass**

Run: `npx vitest run`
Expected: All test files pass

**Step 3: Commit and push**

```bash
git add .github/ tests/ package.json package-lock.json
git commit -m "ci: add GitHub Actions test workflow"
git push origin master
```

**Step 4: Verify CI runs on GitHub**

Run: `gh run list --limit 1`
Expected: Shows a workflow run in progress or completed
