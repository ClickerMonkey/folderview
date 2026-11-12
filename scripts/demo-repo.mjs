// Makes a small demo repository for the screenshots: a TypeScript app with docs (diagrams and math), data files and
// images, three commits, then every kind of change git shows (changed, added, new, deleted, an image changed).
// Nothing in it is real: run it anywhere. Usage: node scripts/demo-repo.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const IMAGES = {
  'dawn.png': (x, y) => mix([255, 170, 120], [90, 80, 200], y / 300),
  'ocean.png': (x, y) => mix([20, 90, 160], [120, 220, 230], (Math.sin(x / 18) + 1) / 4 + y / 600),
  'sun.png': (x, y) => ((x - 200) ** 2 + (y - 150) ** 2 < 70 ** 2 ? [255, 196, 64] : mix([40, 50, 110], [20, 20, 50], y / 300)),
  'rings.png': (x, y) => (Math.floor(Math.hypot(x - 200, y - 150) / 18) % 2 ? [94, 92, 230] : [236, 236, 250]),
  'stripes.png': (x, y) => (Math.floor((x + y) / 24) % 2 ? [36, 170, 120] : [220, 245, 235]),
  'dots.png': (x, y) => ((x % 40) - 20) ** 2 + ((y % 40) - 20) ** 2 < 100 ? [235, 90, 70] : [250, 244, 236],
  'hills.png': (x, y) => (y > 200 + 30 * Math.sin(x / 40) ? [70, 140, 80] : y > 160 + 25 * Math.sin(x / 25 + 1) ? [110, 170, 100] : mix([160, 210, 255], [240, 250, 255], y / 200)),
  'grid.png': (x, y) => (x % 32 < 2 || y % 32 < 2 ? [120, 120, 140] : [246, 246, 250]),
};
const image = (name, alt = false) => png(400, 300, alt ? (x, y) => mix(IMAGES[name](x, y), [255, 120, 40], 0.35) : IMAGES[name]);

const FILES = {
  'README.md': `# Trailhead

A tiny service that keeps hiking trail reports: who walked where, how it went, and what to bring next time.

> [!TIP]
> Start it with \`npm start\`, then open <http://localhost:3000/trails>.

## What's inside

| Folder | What |
|---|---|
| [src/](src/) | The server, its routes and a small cache |
| [docs/](docs/) | How it fits together (with diagrams) |
| [data/](data/) | Sample trails and settings |
| [assets/](assets/) | Pictures for the trail cards |

See [the architecture](docs/architecture.md) for the moving parts.
`,
  'package.json': JSON.stringify(
    { name: 'trailhead', version: '0.3.0', private: true, type: 'module', scripts: { start: 'node dist/index.js', build: 'tsc', test: 'node --test' }, dependencies: {}, devDependencies: { typescript: '^5.7.0' } },
    null,
    2,
  ),
  '.gitignore': 'dist/\nnode_modules/\n*.log\n',
  'src/index.ts': `import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
createServer().listen(port, () => console.log(\`trailhead on http://localhost:\${port}\`));
`,
  'src/server.ts': `// The HTTP server: routes requests to handlers and keeps recent answers in a cache.
import http from 'node:http';
import { listTrails, getTrail } from './routes/trails.js';
import { Cache } from './lib/cache.js';

const cache = new Cache<string>(100);

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hit = cache.get(url.pathname);
    if (hit) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(hit);
      return;
    }
    let body: unknown;
    if (url.pathname === '/trails') body = await listTrails();
    else if (url.pathname.startsWith('/trails/')) body = await getTrail(url.pathname.slice(8));
    else {
      res.writeHead(404).end('not found');
      return;
    }
    const text = JSON.stringify(body);
    cache.set(url.pathname, text);
    res.writeHead(200, { 'content-type': 'application/json' }).end(text);
  });
}
`,
  'src/routes/trails.ts': `import { readFile } from 'node:fs/promises';

export interface Trail {
  id: string;
  name: string;
  miles: number;
  difficulty: 'easy' | 'moderate' | 'hard';
}

const load = async (): Promise<Trail[]> => JSON.parse(await readFile('data/trails.json', 'utf8'));

export async function listTrails(): Promise<Trail[]> {
  return (await load()).sort((a, b) => a.miles - b.miles);
}

export async function getTrail(id: string): Promise<Trail | undefined> {
  return (await load()).find((t) => t.id === id);
}
`,
  'src/lib/cache.ts': `/** A small least-recently-used cache. */
export class Cache<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly limit = 50) {}

  get(key: string): T | undefined {
    const value = this.items.get(key);
    if (value !== undefined) {
      // touched: move it to the newest end
      this.items.delete(key);
      this.items.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
  }
}
`,
  'src/lib/format.ts': `export const miles = (n: number) => \`\${n.toFixed(1)} mi\`;
export const title = (s: string) => s.replace(/\\b\\w/g, (c) => c.toUpperCase());
`,
  'tests/cache.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/lib/cache.js';

test('the oldest entry goes first', () => {
  const c = new Cache<number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
});
`,
  'docs/architecture.md': `# Architecture

Trailhead is one small HTTP server. Requests go through a cache before they reach a route.

## The parts

\`\`\`mermaid
flowchart TD
  client([Browser or app]) -->|GET /trails| server[server.ts]
  server --> cache{In the cache?}
  cache -->|yes| reply([Answer])
  cache -->|no| routes[routes/trails.ts]
  routes --> data[(data/trails.json)]
  routes --> reply
\`\`\`

## A request

\`\`\`mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  participant D as trails.json
  C->>S: GET /trails/ridge-loop
  S->>D: read
  D-->>S: trails
  S-->>C: 200 { "name": "Ridge Loop" }
\`\`\`

## Difficulty

A trail's effort score combines distance $d$ (miles) and climb $h$ (feet):

$$
E = d + \\frac{h}{500}
$$

so a 4-mile walk with 1,000 feet of climb scores $E = 6$.

> [!NOTE]
> Scores above 10 are marked **hard**.

\`\`\`ts
export const effort = (miles: number, climb: number) => miles + climb / 500;
\`\`\`
`,
  'docs/old-notes.md': `# Old notes

These moved into the README.
`,
  'data/trails.json': JSON.stringify(
    [
      { id: 'ridge-loop', name: 'Ridge Loop', miles: 4.2, difficulty: 'moderate', climb: 1100, tags: ['views', 'shade'] },
      { id: 'creek-walk', name: 'Creek Walk', miles: 1.8, difficulty: 'easy', climb: 120, tags: ['water', 'kids'] },
      { id: 'summit-push', name: 'Summit Push', miles: 9.6, difficulty: 'hard', climb: 3400, tags: ['views'] },
    ],
    null,
    2,
  ),
  'data/reports.csv': `date,trail,hiker,miles,rating
2026-10-02,Ridge Loop,Sam,4.2,5
2026-10-05,Creek Walk,Ana,1.8,4
2026-10-09,Summit Push,Lee,9.6,5
2026-10-12,Ridge Loop,Kim,4.2,3
2026-10-18,Creek Walk,Joe,1.8,5
`,
};

export function makeDemo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Phil');
  git('config', 'user.email', 'phil@example.com');
  git('config', 'core.autocrlf', 'false');
  const commit = (msg, date) => {
    git('add', '-A');
    execFileSync('git', ['commit', '-qm', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  for (const rel of ['README.md', 'package.json', '.gitignore', 'src/index.ts', 'src/server.ts', 'src/routes/trails.ts', 'docs/old-notes.md']) write(rel, FILES[rel]);
  commit('Start Trailhead: a server and one route', '2026-10-01T10:00:00');
  for (const rel of ['src/lib/cache.ts', 'src/lib/format.ts', 'tests/cache.test.ts', 'data/trails.json', 'data/reports.csv']) write(rel, FILES[rel]);
  commit('Add a cache for repeat requests', '2026-10-08T15:30:00');
  write('docs/architecture.md', FILES['docs/architecture.md']);
  for (const name of Object.keys(IMAGES)) write(`assets/${name}`, image(name));
  commit('Document the architecture; add trail pictures', '2026-10-20T09:15:00');

  // the changes the screenshots show
  write(
    'src/server.ts',
    FILES['src/server.ts']
      .replace('const cache = new Cache<string>(100);', "import { withRetry } from './lib/retry.js';\n\nconst cache = new Cache<string>(Number(process.env.CACHE_SIZE ?? 100));")
      .replace("if (url.pathname === '/trails') body = await listTrails();", "if (url.pathname === '/trails') body = await withRetry(() => listTrails());")
      .replace("res.writeHead(404).end('not found');", "res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));"),
  );
  write('src/lib/retry.ts', `/** Runs fn again (up to tries times) when it throws, waiting a little longer each time. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
}
`);
  write('tests/retry.test.ts', "import { test } from 'node:test';\n\ntest.todo('retries three times');\n");
  git('add', 'tests/retry.test.ts');
  fs.rmSync(path.join(dir, 'docs/old-notes.md'));
  git('add', '-A', 'docs/old-notes.md');
  write('assets/sun.png', image('sun.png', true));
  write('dist/index.js', '// built\n');
  write('server.log', 'listening on 3000\n');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('demo-repo.mjs')) {
  const dir = path.resolve(process.argv[2] ?? 'trailhead');
  makeDemo(dir);
  console.log(`demo repository in ${dir}`);
}
