import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  accountVerdict,
  bucketScore,
  countWords,
  hashText,
  normalizeForModel,
  normalizePostText,
  verdictFor,
} from '../lib/text.ts';

const cases: { in: string; out: string }[] = JSON.parse(
  readFileSync(new URL('../training/normalize_cases.json', import.meta.url), 'utf8'),
);

test('normalizeForModel matches the shared fixture (Python must match it too)', () => {
  for (const c of cases) assert.equal(normalizeForModel(c.in), c.out, `input: ${JSON.stringify(c.in)}`);
});

test('countWords matches Python \\b\\w+\\b', () => {
  assert.equal(countWords("It's a café — 3 things!"), 6);
  assert.equal(countWords(''), 0);
});

test('normalizePostText strips "Show more" chrome', () => {
  assert.equal(normalizePostText('A long post… Show more'), 'A long post');
  assert.equal(normalizePostText('a b'), 'a b');
});

test('bucketScore: 2-class score is P(ai); 4-class is expected bucket', () => {
  const two = bucketScore([0, Math.log(3)]);
  assert.ok(Math.abs(two.score - 0.75) < 1e-9);
  assert.ok(bucketScore([-10, -10, -10, 10]).score > 0.99);
  assert.ok(Math.abs(bucketScore([0, 0, 0, 0]).score - 0.5) < 1e-9);
});

test('verdictFor bands', () => {
  assert.equal(verdictFor(0.9, 0.7), 'ai');
  assert.equal(verdictFor(0.6, 0.7), 'unsure');
  assert.equal(verdictFor(0.1, 0.7), 'human');
});

test('accountVerdict needs enough posts and enough AI', () => {
  assert.equal(accountVerdict([0.9, 0.9, 0.9, 0.9], 0.7), null); // too few posts
  assert.ok(accountVerdict([0.9, 0.8, 0.75, 0.2, 0.9], 0.7)); // 4/5 over threshold
  assert.equal(accountVerdict([0.9, 0.1, 0.2, 0.3, 0.1], 0.7), null);
});

test('hashText is stable and short', async () => {
  const a = await hashText('same');
  assert.equal(a, await hashText('same'));
  assert.equal(a.length, 32);
});
