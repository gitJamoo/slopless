// End-to-end check: loads the built Chrome extension into headless Chromium, runs the
// on-device benchmark, then scrolls the demo feed in Flag, Hide and Off modes.
//   npm run build && node scripts/e2e.mjs [--shots dir]
// Env: QUICK=1 skips the benchmark; THRESHOLD=0.5 overrides the AI threshold (useful with a stand-in model).
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ext = resolve('.output/chrome-mv3');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const demo = readFileSync('demo/index.html');
const server = createServer((_req, res) => {
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
sw ??= await ctx.waitForEvent('serviceworker', { timeout: 90_000 });
const id = new URL(sw.url()).host;

const options = await ctx.newPage();
await options.goto(`chrome-extension://${id}/options.html`);
const call = (msg) => options.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const setSettings = (patch) =>
  options.evaluate(async (p) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);

console.log('engine', JSON.stringify((await call({ type: 'status' })).engine));
for (const words of process.env.QUICK ? [] : [20, 60, 150]) {
  const r = await call({ type: 'benchmark', runs: 7, words });
  console.log(`bench ${String(words).padStart(3)}w`, JSON.stringify(r));
}

await setSettings({ mode: 'flag', threshold: Number(process.env.THRESHOLD ?? 0.7) });
const page = await ctx.newPage();
await page.goto('http://localhost:5179/');
const t0 = Date.now();
await page.waitForFunction(
  () => document.querySelectorAll('.slopless-pending').length === 0 &&
    document.querySelectorAll('.slopless-badge, .slopless-bar').length >= 4,
  null,
  { timeout: 120_000 },
);
console.log(`first screen scored in ${Date.now() - t0} ms`);
// scroll through the feed so the reply-bot accumulates enough posts for an account verdict
for (let y = 0; y < 12; y++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, 0));
const summary = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('.slopless-badge')].map((x) => x.textContent);
    return {
      postBadges: b.filter((t) => !t.startsWith('Account')).length,
      accountBadges: b.filter((t) => t.startsWith('Account')).length,
      sample: [...new Set(b)].slice(0, 4),
      hidden: document.querySelectorAll('[data-slopless-hidden]').length,
    };
  });
console.log('flag', JSON.stringify(await summary()));
if (shots) await page.screenshot({ path: join(shots, 'flag.png') });

await setSettings({ mode: 'hide' });
await page.waitForTimeout(800);
console.log('hide', JSON.stringify(await summary()));
if (shots) await page.screenshot({ path: join(shots, 'hide.png') });

await setSettings({ mode: 'off' });
await page.waitForTimeout(500);
console.log('off ', JSON.stringify(await summary()));

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 330, height: 330 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForTimeout(800);
if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
console.log('popup:', (await popup.textContent('#engine'))?.trim());

await ctx.close();
server.close();
