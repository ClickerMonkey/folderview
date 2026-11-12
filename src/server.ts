// The HTTP server: the page, the folder API, git, search, review comments and live-reload events.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { NOISE, RAW_TYPES, inside, isHidden, list, serveRaw, toRel, type Scope } from './files.js';
import { excluder, parseRules } from './glob.js';
import { writeZip, ZIP_LIMITS } from './zip.js';
import type { Settings } from './config.js';
import { Git, type Status } from './git.js';
import { FileIndex } from './search.js';
import { Review, type CommentStatus } from './review.js';
import { watchTree } from './watch.js';

/** What the server needs: the resolved settings (see config.ts); tests pass a partial set. */
export type Options = Pick<Settings, 'root' | 'port' | 'host' | 'reviewDir' | 'readOnly' | 'watch' | 'git' | 'allowHosts'> &
  Partial<Pick<Settings, 'exclude' | 'hide' | 'showSecrets' | 'token' | 'base' | 'title' | 'author' | 'maxFileMb'>> & {
    /** how the review folder is named on the page (the screenshots keep theirs in a temporary folder) */
    reviewLabel?: string;
  };

export interface Running {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, 'client');
const version = readVersion();

const STATIC: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export async function start(opts: Options): Promise<Running> {
  const root = path.resolve(opts.root);
  const scope: Scope = {
    root,
    hidden: new Set(['.git', ...(opts.hide ?? [])]),
    hideSecrets: !opts.showSecrets,
    excluded: excluder(parseRules(opts.exclude ?? [])),
  };
  const git = opts.git ? await Git.open(root) : undefined;
  const base = opts.base ?? '/';
  const token = opts.token ?? '';
  const maxFile = (opts.maxFileMb ?? 5) * 1048576;
  const index = new FileIndex(scope, git, (opts.maxFileMb ?? 5) * 1048576);
  const review = new Review(path.resolve(root, opts.reviewDir), root);
  const reviewRel = toRel(scope, review.jsonPath);
  const author = opts.author || (git && (await git.userName())) || os.userInfo().username || 'reviewer';
  const visible = (rel: string) => !rel.split('/').some((p) => isHidden(scope, p)) && !scope.excluded(rel);

  // ── live events ──
  const clients = new Set<http.ServerResponse>();
  const broadcast = (type: string, data: unknown) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  let status: Promise<Status> | undefined;
  // the review notes are ours, not the project's: keep them out of the changes
  const reviewPrefix = reviewRel.startsWith('..') ? '' : toRel(scope, review.dir) + '/';
  const gitStatus = () =>
    (status ??= git
      ? git.status().then((s) => ({
          ...s,
          changes: s.changes.filter((c) => (!reviewPrefix || !c.path.startsWith(reviewPrefix)) && visible(c.path)),
          ignored: s.ignored.filter((i) => visible(i.replace(/\/$/, ''))),
        }))
      : Promise.reject(new Error('not a git repository')));
  const stopWatch = opts.watch
    ? watchTree(root, git ? path.join(git.top, '.git') : undefined, (b) => {
        if (b.git) status = undefined;
        if (b.folders.length || b.files.length) index.invalidate();
        broadcast('change', b);
      })
    : () => undefined;
  review.onChange(() => broadcast('comments', { count: review.all().length }));
  review.watch();
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  ping.unref();

  const allowed = allowedHosts(opts);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding: a page on another site that resolves its name to this machine is refused
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!allowed(host)) return json(res, 403, { error: `Host "${host}" is not allowed. Start with --allow-host ${host} to allow it.` });
    const url = new URL(req.url ?? '/', 'http://x');
    // served under a path (behind a proxy): everything lives below it
    if (base !== '/') {
      if (url.pathname === base.slice(0, -1)) return void res.writeHead(301, { location: base + url.search }).end();
      if (!url.pathname.startsWith(base)) return json(res, 404, { error: 'not found' });
    }
    const p = '/' + url.pathname.slice(base.length);
    // a token: once in the address (it becomes a cookie), as a bearer header, or the cookie
    if (token) {
      const given = url.searchParams.get('token') ?? bearer(req) ?? cookie(req, 'codeview_token') ?? '';
      if (!same(given, token)) {
        if (p === '/' || p === '/index.html') return void res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOCKED);
        return json(res, 401, { error: 'This codeview needs its token: open the link with ?token=… once.' });
      }
      if (url.searchParams.has('token')) {
        // keep it as a cookie and take it out of the address bar
        url.searchParams.delete('token');
        res.setHeader('set-cookie', `codeview_token=${encodeURIComponent(token)}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=31536000`);
        if (p === '/' || p === '/index.html') return void res.writeHead(302, { location: base + (url.search || '') }).end();
      }
    }
    const q = (k: string) => url.searchParams.get(k) ?? '';
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      // writes come only from this page: a JSON body and our own origin
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin write refused' });
      if (opts.readOnly) return json(res, 403, { error: 'This codeview is read-only' });
    }

    if (p === '/' || p === '/index.html') return sendStatic(res, path.join(clientDir, 'index.html'));
    if (p.startsWith('/assets/')) {
      const abs = path.resolve(clientDir, '.' + p);
      if (!abs.startsWith(clientDir + path.sep)) return json(res, 404, { error: 'not found' });
      return sendStatic(res, abs);
    }
    if (p.startsWith('/raw/')) {
      const rel = decodeURIComponent(p.slice(5));
      if (q('download') === '1') res.setHeader('content-disposition', disposition(path.basename(rel)));
      return serveRaw(scope, rel, req, res, q('as') === 'page');
    }
    if (p === '/api/zip') return zipFolder(q('p'), res);

    if (p === '/api/info') {
      return json(res, 200, {
        name: opts.title || path.basename(root) || root,
        // the home folder as ~, so a shared screen or screenshot doesn't show the user's account name
        root: root.startsWith(os.homedir()) ? '~' + root.slice(os.homedir().length) : root,
        version,
        git: !!git,
        gitPrefix: git?.prefix ?? '',
        author,
        readOnly: opts.readOnly,
        review: { json: reviewRel, md: toRel(scope, review.mdPath), dir: opts.reviewLabel ?? opts.reviewDir },
        hostname: os.hostname(),
        maxFile,
        token: !!token,
      });
    }
    if (p === '/api/list') {
      const entries = list(scope, q('p'));
      return entries ? json(res, 200, { entries }) : json(res, 404, { error: 'No such folder' });
    }
    if (p === '/api/stat') {
      const abs = inside(scope, q('p'));
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
      const st = fs.statSync(abs);
      return json(res, 200, { type: st.isDirectory() ? 'folder' : 'file', size: st.size, mtime: st.mtimeMs });
    }
    if (p === '/api/files') return json(res, 200, { files: await index.files() });
    if (p === '/api/search') {
      if (!q('q')) return json(res, 400, { error: 'Nothing to search for' });
      const result = await index.search({
        q: q('q'),
        scope: q('scope'),
        regex: q('regex') === '1',
        caseSensitive: q('case') === '1',
        word: q('word') === '1',
        include: q('include'),
      });
      // the review notes would match every word that was commented on: leave them out
      if (reviewPrefix) result.files = result.files.filter((f) => !f.path.startsWith(reviewPrefix));
      return json(res, 200, result);
    }

    if (p.startsWith('/api/git/')) {
      if (!git) return json(res, 404, { error: 'Not a git repository' });
      const rel = q('p');
      if (p !== '/api/git/status' && inside(scope, rel) === undefined) return json(res, 404, { error: 'not found' });
      switch (p) {
        case '/api/git/status':
          return json(res, 200, await gitStatus());
        case '/api/git/diff':
          return text(res, await git.diff(rel));
        case '/api/git/show': {
          const rev = q('rev') || 'HEAD';
          if (!isRev(rev)) return json(res, 400, { error: 'bad revision' });
          return text(res, await git.show(rel, rev));
        }
        case '/api/git/raw': {
          const rev = q('rev') || 'HEAD';
          if (!isRev(rev)) return json(res, 400, { error: 'bad revision' });
          const buf = await git.showRaw(rel, rev);
          const ext = path.extname(rel).slice(1).toLowerCase();
          res.writeHead(200, { 'content-type': RAW_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
          return void res.end(buf);
        }
        case '/api/git/log':
          return json(res, 200, { commits: await git.log(rel) });
        case '/api/git/commit': {
          const h = q('h');
          if (!isRev(h)) return json(res, 400, { error: 'bad revision' });
          return text(res, await git.commitDiff(rel, h));
        }
      }
      return json(res, 404, { error: 'not found' });
    }

    if (p === '/api/review.md') {
      return text(res, fs.existsSync(review.mdPath) ? fs.readFileSync(review.mdPath, 'utf8') : 'No comments yet.\n', 'text/markdown; charset=utf-8');
    }
    if (p === '/api/comments' && method === 'GET') return json(res, 200, { comments: review.all() });
    if (p === '/api/comments' && method === 'POST') {
      const b = await body(req);
      const rel = str(b['path']);
      if (inside(scope, rel) === undefined) return json(res, 400, { error: 'No such file' });
      if (!str(b['body']).trim()) return json(res, 400, { error: 'The comment is empty' });
      const line = num(b['line']),
        endLine = num(b['endLine']);
      const c = review.add({
        path: rel,
        body: str(b['body']),
        author: str(b['author']) || author,
        ...(line ? { line } : {}),
        ...(endLine ? { endLine } : {}),
        ...(git ? { commit: (await gitStatus().catch(() => undefined))?.head ?? '' } : {}),
      });
      return json(res, 201, c);
    }
    if (p === '/api/comments' && method === 'DELETE' && q('resolved') === '1') return json(res, 200, { removed: review.clearResolved() });
    const m = /^\/api\/comments\/([0-9a-f]+)(\/replies)?$/.exec(p);
    if (m) {
      const id = m[1] ?? '';
      if (m[2] && method === 'POST') {
        const b = await body(req);
        const c = review.reply(id, str(b['author']) || author, str(b['body']));
        return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
      }
      if (method === 'PATCH') {
        const b = await body(req);
        const s = str(b['status']);
        const patch: { body?: string; status?: CommentStatus } = {};
        if (typeof b['body'] === 'string') patch.body = b['body'];
        if (s === 'open' || s === 'resolved') patch.status = s;
        const c = review.update(id, patch);
        return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
      }
      if (method === 'DELETE') return review.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: {"watch":${opts.watch}}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  /** a folder as a zip: what the listing shows (no hidden, excluded or noise folders), within the zip limits */
  async function zipFolder(rel: string, res: http.ServerResponse): Promise<void> {
    const abs = inside(scope, rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return json(res, 404, { error: 'No such folder' });
    const name = rel ? path.basename(abs) : path.basename(root) || 'folder';
    const files: { abs: string; name: string }[] = [];
    let bytes = 0;
    const stack = [rel];
    while (stack.length) {
      const dir = stack.pop() ?? '';
      for (const e of list(scope, dir) ?? []) {
        const child = dir ? dir + '/' + e.name : e.name;
        if (e.type === 'folder') {
          if (!NOISE.has(e.name)) stack.push(child);
          continue;
        }
        bytes += e.size;
        files.push({ abs: path.join(root, child), name: path.posix.join(name, rel ? child.slice(rel.length + 1) : child) });
      }
      if (files.length > ZIP_LIMITS.files || bytes > ZIP_LIMITS.bytes)
        return json(res, 413, { error: `Too big to zip here (${files.length.toLocaleString()} files, ${Math.round(bytes / 1048576)} MB so far)` });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': disposition(name + '.zip'), 'cache-control': 'no-store' });
    await writeZip(res, files);
    res.end();
  }

  const port = await listen(server, opts.port, opts.host);
  return {
    server,
    port,
    close: async () => {
      stopWatch();
      review.close();
      clearInterval(ping);
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** listen on the port, or the next free one */
function listen(server: http.Server, port: number, host: string, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 1 && port !== 0) resolve(listen(server, port + 1, host, tries - 1));
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const LOCKED =
  '<!doctype html><meta name="viewport" content="width=device-width"><title>codeview</title><body style="font:16px system-ui;padding:2em;max-width:36em;margin:auto"><h1>🔒 This codeview needs its token</h1><p>Open the link you were given (it ends in <code>?token=…</code>). It is kept as a cookie, so you only need it once.</p>';

const bearer = (req: http.IncomingMessage) => /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
const cookie = (req: http.IncomingMessage, name: string) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};
function same(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function allowedHosts(opts: Options): (host: string) => boolean {
  const names = new Set(['localhost', os.hostname().toLowerCase(), ...opts.allowHosts.map((h) => h.toLowerCase())]);
  if (opts.host !== '0.0.0.0' && opts.host !== '::') names.add(opts.host.toLowerCase());
  return (h) =>
    names.has(h) ||
    h.endsWith('.localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || // an IP address can't be rebound
    h.includes(':') || // IPv6 literal
    opts.allowHosts.includes('*');
}

function isRev(r: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(r) || /^HEAD(~\d{1,4}|\^)?$/.test(r);
}

function sendStatic(res: http.ServerResponse, abs: string): void {
  fs.readFile(abs, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': STATIC[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
  });
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(data));
}

function text(res: http.ServerResponse, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new Error('Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > 1_000_000) throw new Error('Too large');
    chunks.push(b);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Send a JSON object');
  return Object.fromEntries(Object.entries(data));
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' && 'version' in pkg ? String(pkg.version) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
