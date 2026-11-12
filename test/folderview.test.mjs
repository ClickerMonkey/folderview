// Runs against the built dist/ (npm test builds first).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inside, list, isSecret } from '../dist/files.js';
import { FileIndex } from '../dist/search.js';
import { pathFilter, excluder, parseRules } from '../dist/glob.js';
import { resolve as resolveConfig } from '../dist/config.js';
import { crc32 } from '../dist/zip.js';
import { Git } from '../dist/git.js';
import { Review, toMarkdown } from '../dist/review.js';
import { start } from '../dist/server.js';

let root;
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString();
const write = (p, t) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), t);
};

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folderview-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  write('src/a.ts', 'export const a = 1;\nexport const findMe = 2;\n');
  write('src/b.ts', 'const b = 1;\n');
  write('old.txt', 'old\n');
  write('.gitignore', 'build/\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  write('src/a.ts', 'export const a = 10;\nexport const findMe = 2;\nexport const c = 3;\n');
  fs.rmSync(path.join(root, 'old.txt'));
  write('new.md', '# New\n');
  write('build/out.js', 'built\n');
  write('.env', 'SECRET=1\n');
  write('id_rsa', 'key\n');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const scope = (exclude = []) => ({ root, hidden: new Set(['.git']), hideSecrets: true, excluded: excluder(parseRules(exclude)) });

test('paths stay inside the root and away from hidden and secret files', () => {
  const s = scope();
  assert.equal(inside(s, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(inside(s, '../outside'), undefined);
  assert.equal(inside(s, 'src/../../x'), undefined);
  assert.equal(inside(s, '.git/config'), undefined);
  assert.equal(inside(s, '.env'), undefined);
  assert.equal(inside(s, 'id_rsa'), undefined);
  assert.ok(isSecret('.env.local') && !isSecret('.env.example') && isSecret('server.pem'));
  const names = list(s, '').map((e) => e.name);
  assert.ok(names.includes('src') && names.includes('new.md'));
  assert.ok(!names.includes('.git') && !names.includes('.env') && !names.includes('id_rsa'));
});

test('include and exclude filters', () => {
  const f = pathFilter('*.ts, !*.test.ts');
  assert.ok(f('src/a.ts'));
  assert.ok(!f('src/a.test.ts'));
  assert.ok(!f('README.md'));
  const g = pathFilter('src/**');
  assert.ok(g('src/deep/x.js') && !g('lib/x.js'));
  assert.ok(pathFilter('')('anything'));
});

test('git status: changed, deleted, new and ignored', async () => {
  const g = await Git.open(root);
  assert.ok(g);
  const s = await g.status();
  assert.equal(s.branch, 'main');
  const by = Object.fromEntries(s.changes.map((c) => [c.path, c]));
  assert.equal(by['src/a.ts'].state, 'modified');
  assert.equal(by['src/a.ts'].add, 2);
  assert.equal(by['src/a.ts'].del, 1);
  assert.equal(by['old.txt'].state, 'deleted');
  assert.equal(by['new.md'].state, 'new');
  assert.ok(s.ignored.includes('build/'));
  assert.match(await g.diff('src/a.ts'), /^\+export const c = 3;$/m);
  assert.match(await g.diff('new.md'), /^\+# New$/m);
  assert.equal(await g.show('old.txt'), 'old\n');
  assert.equal((await g.log('src/a.ts'))[0].subject, 'first');
});

test('search finds lines, names, and respects scope and options', async () => {
  const idx = new FileIndex(scope(), await Git.open(root));
  const r = await idx.search({ q: 'findme', scope: '', regex: false, caseSensitive: false, word: false, include: '' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, 'src/a.ts');
  assert.equal(r.files[0].matches[0].line, 2);
  assert.deepEqual(r.files[0].matches[0].hits, [[13, 19]]);
  const cs = await idx.search({ q: 'findme', scope: '', regex: false, caseSensitive: true, word: false, include: '' });
  assert.equal(cs.files.length, 0);
  const rx = await idx.search({ q: 'const [ab] =', scope: 'src', regex: true, caseSensitive: false, word: false, include: '' });
  assert.deepEqual(rx.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
  const ign = await idx.search({ q: 'built', scope: '', regex: false, caseSensitive: false, word: false, include: '' });
  assert.equal(ign.files.length, 0, 'ignored files are not searched');
  const sec = await idx.search({ q: 'SECRET', scope: '', regex: false, caseSensitive: true, word: false, include: '' });
  assert.equal(sec.files.length, 0, 'secret files are not searched');
  const bad = await idx.search({ q: '(', scope: '', regex: true, caseSensitive: false, word: false, include: '' });
  assert.ok(bad.error);
});

test('review comments: saved, quoted, replied, resolved, and written as markdown', () => {
  const dir = path.join(root, '.review-test');
  const r = new Review(dir, root);
  const c = r.add({ path: 'src/a.ts', line: 1, endLine: 2, body: 'Rename these.', author: 'Phil', commit: 'abc1234' });
  assert.equal(c.quote, 'export const a = 10;\nexport const findMe = 2;');
  r.reply(c.id, 'agent', 'Done.');
  r.update(c.id, { status: 'resolved' });
  const f = r.add({ path: 'new.md', body: 'Whole-file note', author: 'Phil' });
  assert.equal(f.line, undefined);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'comments.json'), 'utf8'));
  assert.equal(saved.comments.length, 2);
  const md = fs.readFileSync(path.join(dir, 'REVIEW.md'), 'utf8');
  assert.match(md, /1 open · 1 resolved/);
  assert.match(md, /`src\/a\.ts:1-2` — Phil @ abc1234/);
  assert.match(md, /> \*\*agent\*\*: Done\./);
  assert.match(md, /`new\.md \(whole file\)`/);
  // an edit from outside (an agent) is picked up
  saved.comments.find((x) => x.path === 'new.md').status = 'resolved';
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(saved));
  const again = new Review(dir, root);
  assert.equal(again.all().filter((x) => x.status === 'open').length, 0);
  assert.ok(r.remove(c.id));
  assert.match(toMarkdown([], 'x.json'), /No comments yet/);
});

test('the server: pages, raw files, host and origin checks, comments', async () => {
  const s = await start({
    root,
    port: 0,
    host: '127.0.0.1',
    reviewDir: '.review',
    git: true,
    watch: false,
    readOnly: false,
    allowHosts: [],
  });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/assets/main.js')).status, 200);
    assert.equal((await fetch(base + '/assets/../package.json')).status, 404);
    const info = await (await fetch(base + '/api/info')).json();
    assert.equal(info.git, true);
    assert.equal(await (await fetch(base + '/raw/src/b.ts')).text(), 'const b = 1;\n');
    const part = await fetch(base + '/raw/src/b.ts', { headers: { range: 'bytes=0-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'const');
    assert.equal((await fetch(base + '/raw/.env')).status, 404);
    assert.equal((await fetch(base + '/raw/..%2f..%2fetc%2fpasswd')).status, 404);
    // a page on another site that points its name at this machine is refused
    const http = await import('node:http');
    const status = await new Promise((res) => http.get(base + '/api/info', { headers: { host: 'evil.example' } }, (r) => res(r.statusCode)));
    assert.equal(status, 403);
    // writes from another origin are refused
    const cross = await fetch(base + '/api/comments', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    const made = await fetch(base + '/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'src/b.ts', line: 1, body: 'Hi' }) });
    assert.equal(made.status, 201);
    const c = await made.json();
    assert.equal(c.quote, 'const b = 1;');
    assert.equal(c.author, 'Tester');
    const outside = await fetch(base + '/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '../x', body: 'Hi' }) });
    assert.equal(outside.status, 400);
    const st = await (await fetch(base + '/api/git/status')).json();
    assert.ok(!st.changes.some((x) => x.path.startsWith('.review/')), 'the review notes are not listed as changes');
    const md = await (await fetch(base + '/api/review.md')).text();
    assert.match(md, /src\/b\.ts:1/);
  } finally {
    await s.close();
  }
});

test('history, a commit and its diffs, and comments on an area of an image', async () => {
  const s = await start({ root, port: 0, host: '127.0.0.1', reviewDir: '.review-img', git: true, watch: false, readOnly: false, allowHosts: [] });
  const base = `http://127.0.0.1:${s.port}`;
  const post = (body) => fetch(base + '/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const h = await (await fetch(base + '/api/git/history')).json();
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].subject, 'first');
    assert.equal(h.commits[0].state, 'unknown', 'no remote, so nothing is pushed or not');
    assert.equal(h.remotes, false);
    assert.equal((await (await fetch(base + '/api/git/history?q=FIRST')).json()).commits.length, 1, 'search ignores case');
    assert.equal((await (await fetch(base + '/api/git/history?q=nothing-like-this')).json()).commits.length, 0);
    assert.equal((await (await fetch(base + '/api/git/history?q=' + h.commits[0].hash)).json()).commits[0].hash, h.commits[0].hash, 'a hash finds its commit');
    const log = await (await fetch(base + '/api/git/log?p=src/b.ts')).json();
    assert.equal(log.commits.length, 1);
    assert.equal(log.more, false);
    const info = await (await fetch(base + '/api/git/commit-info?h=' + h.commits[0].hash)).json();
    assert.equal(info.commit.subject, 'first');
    const b = info.files.find((f) => f.path === 'src/b.ts');
    assert.equal(b.state, 'added');
    assert.equal(b.add, 1);
    const d = await (await fetch(`${base}/api/git/commit-diff?h=${info.commit.full}&p=src/b.ts`)).text();
    assert.match(d, /\+const b = 1;/);
    assert.equal((await fetch(`${base}/api/git/commit-diff?h=;rm&p=src/b.ts`)).status, 400);

    // a 1×1 PNG stands in for the marked-up picture
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const made = await post({ path: 'src/b.ts', body: 'This bit', strokes: [[0.1, 0.1, 0.5, 0.5], [2, 'x']], area: { x: 1, y: 2, w: 30, h: 40 }, snapshot: png });
    assert.equal(made.status, 201);
    const c = await made.json();
    assert.deepEqual(c.area, { x: 1, y: 2, w: 30, h: 40 });
    assert.deepEqual(c.strokes, [[0.1, 0.1, 0.5, 0.5]], 'points outside 0–1 are dropped');
    assert.equal(c.image, `images/${c.id}.png`);
    const img = await fetch(`${base}/api/comments/${c.id}/image.png`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.ok(fs.existsSync(path.join(root, '.review-img', c.image)));
    const md = fs.readFileSync(path.join(root, '.review-img', 'REVIEW.md'), 'utf8');
    assert.match(md, /src\/b\.ts \(marked area\)/);
    assert.match(md, new RegExp(`!\\[The marked area\\]\\(images/${c.id}\\.png\\)`));
    // something that isn't a PNG is not saved
    const bad = await (await post({ path: 'src/b.ts', body: 'x', strokes: [[0.1, 0.1]], snapshot: 'data:image/png;base64,PHN2Zz4=' })).json();
    assert.equal(bad.image, undefined);
    await fetch(`${base}/api/comments/${c.id}`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(path.join(root, '.review-img', c.image)), 'deleting the comment deletes its picture');
  } finally {
    await s.close();
    fs.rmSync(path.join(root, '.review-img'), { recursive: true, force: true });
  }
});

test('exclude patterns: names, folders, anchored paths, ** and exceptions', () => {
  const ex = excluder(parseRules(['*.log', 'dist/', '/secret', 'docs/**/*.tmp', '!keep.log']));
  assert.ok(ex('a.log') && ex('deep/b.log'));
  assert.ok(!ex('keep.log'));
  assert.ok(ex('dist', true) && ex('dist/x.js') && ex('pkg/dist/y.js'));
  assert.ok(!ex('dist'), 'dist/ only matches a folder');
  assert.ok(ex('secret') && ex('secret/x') && !ex('a/secret'));
  assert.ok(ex('docs/a/b/c.tmp') && !ex('other/c.tmp'));
  const s = scope(['src/b.ts', '*.md']);
  assert.equal(inside(s, 'src/b.ts'), undefined);
  assert.equal(inside(s, 'new.md'), undefined);
  const names = list(s, 'src').map((e) => e.name);
  assert.deepEqual(names, ['a.ts']);
});

test('settings: flags beat environment beat .folderviewrc.json beat the global config; lists add up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'folderview-home-'));
  fs.mkdirSync(path.join(home, 'folderview'));
  fs.writeFileSync(path.join(home, 'folderview', 'config.json'), JSON.stringify({ port: 5000, exclude: ['*.global'], title: 'Global' }));
  fs.writeFileSync(path.join(root, '.folderviewrc.json'), JSON.stringify({ port: 5100, exclude: ['*.project'], readOnly: true }));
  fs.writeFileSync(path.join(root, '.folderviewignore'), '# comment\n*.ignored\n');
  try {
    const env = { XDG_CONFIG_HOME: home, FOLDERVIEW_PORT: '5200', FOLDERVIEW_EXCLUDE: '*.env1,*.env2', FOLDERVIEW_READ_ONLY: 'false' };
    const r = resolveConfig([root, '--exclude', '*.flag', '--title', 'Flag'], env).settings;
    assert.equal(r.port, 5200);
    assert.equal(r.title, 'Flag');
    assert.equal(r.readOnly, false);
    assert.deepEqual(r.exclude, ['*.global', '*.project', '*.env1', '*.env2', '*.flag', '*.ignored']);
    assert.equal(r.sources.port, 'environment');
    const f = resolveConfig([root, '-p', '6000', '--lan', '--base', 'code'], env).settings;
    assert.equal(f.port, 6000);
    assert.equal(f.host, '0.0.0.0');
    assert.equal(f.base, '/code/');
    assert.throws(() => resolveConfig([root, '--nope'], {}), /Unknown option/);
    assert.throws(() => resolveConfig([root, '--port', 'x'], {}), /port/);
  } finally {
    fs.rmSync(path.join(root, '.folderviewrc.json'));
    fs.rmSync(path.join(root, '.folderviewignore'));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('downloads, folder zips, a token and a base path', async () => {
  const s = await start({ root, port: 0, host: '127.0.0.1', reviewDir: '.review', git: true, watch: false, readOnly: false, allowHosts: [], token: 's3cret', base: '/code/', exclude: ['*.md'] });
  const base = `http://127.0.0.1:${s.port}/code/`;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/info`)).status, 404, 'nothing outside the base path');
    assert.equal((await fetch(base + 'api/info')).status, 401, 'no token, no entry');
    const page = await fetch(base + '?token=s3cret', { redirect: 'manual' });
    assert.equal(page.status, 302);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const auth = { headers: { cookie } };
    assert.equal((await fetch(base + 'api/info', auth)).status, 200);
    assert.equal((await fetch(base + 'api/info', { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await fetch(base + 'api/info', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const dl = await fetch(base + 'raw/src/b.ts?download=1', auth);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="b\.ts"/);
    assert.equal((await fetch(base + 'raw/new.md', auth)).status, 404, 'excluded files are not served');
    const zip = Buffer.from(await (await fetch(base + 'api/zip?p=src', auth)).arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip');
    const names = [];
    for (let i = 0; i < zip.length - 4; i++) if (zip.readUInt32LE(i) === 0x02014b50) names.push(zip.toString('utf8', i + 46, i + 46 + zip.readUInt16LE(i + 28)));
    assert.deepEqual(names.sort(), ['src/a.ts', 'src/b.ts']);
    // the stored CRC matches the file
    const at = zip.indexOf(Buffer.from('src/a.ts')) - 30;
    assert.equal(zip.readUInt32LE(at + 14), crc32(fs.readFileSync(path.join(root, 'src/a.ts'))));
  } finally {
    await s.close();
  }
});

test('folderview review prints the open comments, or says there are none', () => {
  const dir = path.join(root, '.review-cli');
  const r = new Review(dir, root);
  const run = (...a) => execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'dist', 'cli.js'), 'review', root, '--review-dir', dir, ...a], { encoding: 'utf8' });
  assert.match(run(), /No review comments yet/);
  const c = r.add({ path: 'src/b.ts', line: 1, body: 'Rename b.', author: 'Phil' });
  const out = run();
  assert.match(out, /1 open/);
  assert.match(out, /`src\/b\.ts:1` — Phil/);
  assert.match(out, /Rename b\./);
  r.update(c.id, { status: 'resolved' });
  assert.match(run(), /No open review comments \(1 resolved/);
  const json = JSON.parse(run('--all', '--json'));
  assert.equal(json.comments.length, 1);
  assert.match(json.instructions, /set that comment's "status" to "resolved"/);
});
