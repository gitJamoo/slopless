import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketScore, cleanForModel, countWords, hashText, normalizePostText, pangramCostUsd, verdictFor } from '../lib/text.ts';

test('cleanForModel mirrors EditLens preprocessing', () => {
  assert.equal(cleanForModel('Hello   World\n\nThis IS fine 🚀'), 'hello world this is fine');
  assert.equal(cleanForModel('Sure! Here is your post:\nActual content here'), 'actual content here');
  assert.equal(cleanForModel('<think>plan</think> Done.'), 'done.');
  // single paragraph starting with a boilerplate word is kept
  assert.equal(cleanForModel('Here we go again'), 'here we go again');
});

test('countWords handles unicode and punctuation', () => {
  assert.equal(countWords("It's a café — 3 things!"), 6); // matches Python's \b\w+\b (it, s, a, café, 3, things)
  assert.equal(countWords(''), 0);
});

test('normalizePostText strips "Show more" chrome', () => {
  assert.equal(normalizePostText('A long post… Show more'), 'A long post');
  assert.equal(normalizePostText('a b'), 'a b');
});

test('bucketScore is expected bucket / (n-1)', () => {
  const allAi = bucketScore([-10, -10, -10, 10]);
  assert.ok(allAi.score > 0.99);
  const allHuman = bucketScore([10, -10, -10, -10]);
  assert.ok(allHuman.score < 0.01);
  const uniform = bucketScore([0, 0, 0, 0]);
  assert.ok(Math.abs(uniform.score - 0.5) < 1e-9);
  assert.ok(Math.abs(uniform.probs.reduce((a, b) => a + b) - 1) < 1e-9);
});

test('verdictFor bands', () => {
  assert.equal(verdictFor(0.9, 0.7), 'ai');
  assert.equal(verdictFor(0.5, 0.7), 'edited');
  assert.equal(verdictFor(0.1, 0.7), 'human');
});

test('pangramCostUsd bills per started 100 words, min 1 block', () => {
  assert.equal(pangramCostUsd(0), 0.05);
  assert.equal(pangramCostUsd(100), 0.05);
  assert.equal(pangramCostUsd(101), 0.1);
});

test('hashText is stable and short', async () => {
  const a = await hashText('same');
  assert.equal(a, await hashText('same'));
  assert.equal(a.length, 32);
  assert.notEqual(a, await hashText('different'));
});
