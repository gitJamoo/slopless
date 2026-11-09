// End-to-end check: loads the built Chrome extension into headless Chromium, runs the
// on-device benchmark, then scrolls the demo feed in Flag, Hide and Rewrite modes.
// Rewrite uses a mock OpenAI-compatible server, so no keys or network are needed.
//   npm run build && node scripts/e2e.mjs [--shots dir]
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ext = resolve('.output/chrome-mv3');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

// demo feed + mock rewrite endpoint
const { readFileSync } = await import('node:fs');
const demo = readFileSync('demo/index.html');
const server = createServer((req, res) => {
  if (req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ choices: [{ message: { content: 'MOCK REWRITE: plain human version.' } }] }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(demo);
});
await new Promise((r) => server.listen(5179, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'slopless-')), {
  headless: true,
  channel: 'chromium', // full Chromium (new headless); the headless shell can't load extensions
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 700, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('extension id', id);

const options = await ctx.newPage();
await options.goto(`chrome-extension://${id}/options.html`);
const call = (msg) => options.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const setSettings = (patch) =>
  options.evaluate(async (p) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);

console.log('status', JSON.stringify((await call({ type: 'status' })).engine));
for (const words of process.env.QUICK ? [] : [40, 100, 250]) {
  const t0 = Date.now();
  const r = await call({ type: 'benchmark', runs: 5, words });
  console.log(`bench ${words}w`, JSON.stringify(r), `(${Date.now() - t0} ms wall)`);
}
console.log('status', JSON.stringify((await call({ type: 'status' })).engine));

await setSettings({
  mode: 'flag',
  detector: 'local',
  // The stand-in model's scores are random-ish; a low threshold makes every UI state show up.
  threshold: Number(process.env.THRESHOLD ?? 0.7),
  rewriteEngine: 'openai',
  openaiBaseUrl: 'http://127.0.0.1:5179/v1',
});

const page = await ctx.newPage();
page.on('console', (m) => m.text().includes('slopless') && console.log('page:', m.text()));
await page.goto('http://localhost:5179/');
const t0 = Date.now();
// "Scored" = nothing blurred and the first screen of posts carries a verdict.
await page.waitForFunction(() => document.querySelectorAll('.slopless-pending').length === 0 &&
  document.querySelectorAll('.slopless-badge, .slopless-bar').length >= 4, null, { timeout: 180_000 });
console.log(`first screen scored in ${Date.now() - t0} ms`);
const summary = () =>
  page.evaluate(() => ({
    badges: [...document.querySelectorAll('.slopless-badge')].map((b) => b.textContent),
    hidden: document.querySelectorAll('[data-slopless-hidden]').length,
    rewritten: document.querySelectorAll('.slopless-rewrite').length,
  }));
console.log('flag', JSON.stringify(await summary()));
if (shots) await page.screenshot({ path: join(shots, 'flag.png') });

await setSettings({ mode: 'hide' });
await page.waitForTimeout(1000);
console.log('hide', JSON.stringify(await summary()));
if (shots) await page.screenshot({ path: join(shots, 'hide.png') });

await setSettings({ mode: 'rewrite' });
await page.waitForFunction(() => document.querySelectorAll('.slopless-rewrite').length > 0, null, { timeout: 30_000 }).catch(() => {});
console.log('rewrite', JSON.stringify(await summary()));
if (shots) await page.screenshot({ path: join(shots, 'rewrite.png') });

await setSettings({ mode: 'off' });
await page.waitForTimeout(500);
console.log('off', JSON.stringify(await summary()));

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 420 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForTimeout(800);
if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
console.log('popup engine line:', await popup.textContent('#engine'));

await ctx.close();
server.close();
