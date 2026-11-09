import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pangramDetect } from '../lib/pangram.ts';

function mockFetch(responses: Array<{ status?: number; body: unknown }>, calls: any[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }) as any;
}

test('submits with model + key, polls until success, combines fractions', async () => {
  const calls: any[] = [];
  mockFetch([
    { body: { task_id: 't1' } },
    { body: { task_id: 't1', stage: 'STAGE_PREPROCESSING' } },
    { body: { stage: 'STAGE_SUCCESS', prediction_short: 'Mixed', fraction_ai: 0.4, fraction_ai_assisted: 0.4, fraction_human: 0.2 } },
  ], calls);
  const r = await pangramDetect('some text', 'KEY');
  assert.equal(r.label, 'Mixed');
  assert.ok(Math.abs(r.score - 0.6) < 1e-9);
  assert.equal(calls[0].url, 'https://text.external-api.pangram.com/task');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-api-key'], 'KEY');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'some text', model: 'pangram-4', public_dashboard_link: false });
  assert.equal(calls[1].url, 'https://text.external-api.pangram.com/task/t1');
});

test('maps auth and failure errors', async () => {
  mockFetch([{ status: 401, body: {} }], []);
  await assert.rejects(pangramDetect('x', 'bad'), /rejected the API key/);
  mockFetch([{ body: { task_id: 't' } }, { body: { stage: 'STAGE_FAILED', headline: 'no valid text' } }], []);
  await assert.rejects(pangramDetect('x', 'k'), /no valid text/);
});
