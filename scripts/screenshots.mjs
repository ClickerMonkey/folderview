// Takes the README's screenshots at phone size: npm run screenshots
// Builds a fresh demo repository (scripts/demo-repo.mjs) in a temporary folder, starts folderview on it, seeds a few
// review comments and saves docs/screenshots/*.png. SHOTS=code,diff takes only those.
// Needs Playwright's Chromium: npx playwright install chromium
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../dist/server.js';
import { makeDemo } from './demo-repo.mjs';

const here = path.resolve(import.meta.dirname, '..');
const out = path.join(here, 'docs', 'screenshots');
const only = process.env.SHOTS ? new Set(process.env.SHOTS.split(',')) : undefined;
fs.mkdirSync(out, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folderview-shots-'));
const target = path.join(tmp, 'trailhead');
makeDemo(target);
const server = await start({ root: target, port: 0, host: '127.0.0.1', readOnly: false, watch: false, git: true, allowHosts: [], reviewDir: '.review', author: 'Phil' });
const base = `http://127.0.0.1:${server.port}/`;

const post = async (p, json, method = 'POST') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
};

const changed = 'src/server.ts';
const line = 8; // the cache line the change touches
const c1 = await post('api/comments', { path: changed, line, endLine: line + 1, body: 'Can the cache size come from the **config** file instead of an environment variable?', author: 'Phil' });
await post(`api/comments/${c1.id}/replies`, { body: 'Done: it reads `cache.size` from `data/config.json`, with 100 as the default.', author: 'agent' });
await post('api/comments', { path: changed, line: 20, body: 'Retry only the list? `getTrail` reads the same file.', author: 'Phil' });
const c3 = await post('api/comments', { path: 'README.md', body: 'Say which Node version it needs.', author: 'Phil' });
await post(`api/comments/${c3.id}`, { status: 'resolved' }, 'PATCH');

const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const fileUrl = (p, extra = '') => `${base}#/${folderOf(p)}?open=${encodeURIComponent(nameOf(p))}${extra}`;

const browser = await chromium.launch();
let count = 0;
async function shot(name, url, { scheme = 'light', prepare, settle = 1200 } = {}) {
  if (only && !only.has(name)) return;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  page.on('pageerror', (e) => console.error(`  ${name}: page error: ${e.message}`));
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  if (prepare) await prepare(page);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
  count++;
  console.log(`  ${name}.png`);
}
const scrollTo = (selector, offset = 110) => async (p) => {
  await p.locator(selector).first().scrollIntoViewIfNeeded();
  await p.evaluate((o) => window.scrollBy(0, -o), offset);
};

console.log(`screenshots of a demo repository (${target}):`);
await shot('folder', base);
await shot('code', fileUrl(changed, `&line=${line}`));
await shot('diff', fileUrl(changed, '&tab=diff'));
await shot('review', fileUrl(changed, `&line=${line + 1}`), {
  prepare: async (p) => {
    await p.evaluate(() => document.querySelector('.selbar')?.remove());
    await scrollTo('.threads', 150)(p);
  },
});
await shot('review-page', `${base}#/?m=review&q=all`);
await shot('markdown', fileUrl('README.md'));
await shot('diagrams', fileUrl('docs/architecture.md'), {
  prepare: async (p) => {
    await p.waitForSelector('.md-diagram img', { timeout: 15000 });
    await scrollTo('h2#the-parts')(p);
  },
  settle: 1500,
});
await shot('math-code', fileUrl('docs/architecture.md'), {
  scheme: 'dark',
  prepare: async (p) => {
    await p.waitForSelector('.md-math math', { timeout: 15000 });
    await scrollTo('h2#difficulty')(p);
  },
  settle: 1500,
});
await shot('changes', `${base}#/?m=changes`);
await shot('search', `${base}#/?m=search&q=cache`);
await shot('quick-open', base, {
  prepare: async (p) => {
    await p.click('#qo-btn');
    await p.fill('#qo-in', 'tr');
    await p.waitForSelector('.qo-item');
  },
});
await shot('thumbnails', `${base}#/assets?view=grid`);
await shot('image', fileUrl('assets/sun.png', '&tab=compare'));
await shot('table', fileUrl('data/reports.csv'));
await shot('json', fileUrl('data/trails.json'));
await shot('history', fileUrl(changed, '&tab=history'), {
  prepare: async (p) => {
    await p.click('.commit');
    await p.waitForSelector('#commit-diff .diff', { timeout: 10000 });
    await p.evaluate(() => window.scrollTo(0, 0));
  },
});
await shot('dark-code', fileUrl('src/lib/cache.ts'), { scheme: 'dark' });
await shot('settings', base, { prepare: (p) => p.click('#settings-btn') });

await browser.close();
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${count} screenshots in ${path.relative(process.cwd(), out) || out}`);
