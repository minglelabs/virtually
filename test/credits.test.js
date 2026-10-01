const test = require('node:test');
const assert = require('node:assert/strict');

const { creditsFor, DEFAULT_CREDITS_PER_USD } = require('../public/credits.js');

test('creditsFor rounds the USD estimate up to whole credits', () => {
  assert.equal(DEFAULT_CREDITS_PER_USD, 2000);
  const cases = [
    [0.3, 2000, 600], // the product rule: $0.30 of model cost = 600 credits (1 credit = 1 KRW)
    [0.24, 2000, 480], // Wan 2.2 Animate 2, 3 s at 720p
    [0.13, 2000, 260],
    [0.241, 2000, 482],
    [0.0001, 2000, 1], // never below one credit
    [0.24, 100, 24],
    [0.13, 100, 13],
    [0.63, 100, 63],
    [0.241, 100, 25],
    [0.29, 100, 29], // 28.999999999999996 in floating point
    [1.1, 100, 110], // 110.00000000000001 in floating point
    [0.0001, 100, 1], // never below one credit
    [0.24, 150, 36],
  ];
  for (const [usd, rate, expected] of cases) {
    assert.equal(creditsFor(usd, rate), expected, `${usd} USD at ${rate} credits/USD`);
  }
});

test('creditsFor defaults the rate and reports unknown or free prices', () => {
  assert.equal(creditsFor(0.3), 600);
  assert.equal(creditsFor(0.24), 480);
  assert.equal(creditsFor(0.24, 0), 480);
  assert.equal(creditsFor(0.24, 1.5), 480);
  assert.equal(creditsFor(0, 100), 0);
  assert.equal(creditsFor(-1, 100), 0);
  for (const unknown of [null, undefined, NaN, Infinity, '0.24']) {
    assert.equal(creditsFor(unknown, 100), null, String(unknown));
  }
});
