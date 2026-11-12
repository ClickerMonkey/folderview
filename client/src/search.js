// Search: the bar at the top, the results page (everywhere or in one folder), and quick open (Ctrl+P).
import { $, api, baseOf, debounce, esc, parentOf } from './util.js';
import { fileHref, go, nav, where } from './state.js';
import { badge, stateOf } from './folder.js';
import { icon } from './icons.js';

let scopeHere = false;

function paintScope() {
  const b = $('scope');
  const folder = where().folder;
  b.textContent = scopeHere && folder ? `in ${baseOf(folder)}` : 'everywhere';
  b.title = scopeHere && folder ? `Searching ${folder}/ (click to search everywhere)` : 'Searching every folder (click to search only the open folder)';
  b.classList.toggle('on', scopeHere && !!folder);
}

export function focusSearch(scope) {
  scopeHere = scope === 'here';
  paintScope();
  $('q').focus();
  $('q').select();
}

export function wireSearchBar() {
  $('search-form').onsubmit = (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (!q) return;
    const w = where();
    go({ folder: w.folder, m: 'search', q, scope: scopeHere && w.folder ? 'here' : '', opts: w.m === 'search' ? w.opts : '', inc: w.m === 'search' ? w.inc : '' });
  };
  $('scope').onclick = () => {
    scopeHere = !scopeHere;
    paintScope();
    const w = where();
    if (w.m === 'search') nav({ scope: scopeHere ? 'here' : '' });
    $('q').focus();
  };
  addEventListener('hashchange', () => {
    const w = where();
    if (w.m === 'search') {
      $('q').value = w.q;
      scopeHere = w.scope === 'here';
    }
    paintScope();
  });
  const w = where();
  if (w.m === 'search') {
    $('q').value = w.q;
    scopeHere = w.scope === 'here';
  }
  paintScope();
}

const mark = (text, hits) => {
  let out = '',
    at = 0;
  for (const [a, b] of hits) {
    out += esc(text.slice(at, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    at = b;
  }
  return out + esc(text.slice(at));
};

let searchToken = 0;
export async function renderSearch(el) {
  const w = where();
  const opts = w.opts || '';
  const here = w.scope === 'here' && w.folder;
  const toggle = (k, label, title) => `<button class="btn small${opts.includes(k) ? ' on' : ''}" data-o="${k}" title="${title}">${label}</button>`;
  el.innerHTML = `<header class="head"><h2 class="page-title">${icon('search')} “${esc(w.q)}”</h2></header>
  <div class="head search-opts">
    ${toggle('c', 'Aa', 'Match case')}${toggle('w', '<u>ab</u>', 'Whole word')}${toggle('r', '.*', 'Regular expression')}
    <input class="filter" id="inc" placeholder="Files to include: *.ts, src/**, !*.test.ts" value="${esc(w.inc)}" aria-label="Files to include">
    <span class="scope-chips"><button class="btn small${here ? '' : ' on'}" data-sc="">Everywhere</button>${w.folder ? `<button class="btn small${here ? ' on' : ''}" data-sc="here">In ${esc(w.folder)}/</button>` : ''}</span>
  </div>
  <div id="results"><p class="note">Searching…</p></div>`;
  el.querySelectorAll('[data-o]').forEach((b) => (b.onclick = () => nav({ opts: opts.includes(b.dataset.o) ? opts.replace(b.dataset.o, '') : opts + b.dataset.o })));
  el.querySelectorAll('[data-sc]').forEach((b) => (b.onclick = () => nav({ scope: b.dataset.sc })));
  const inc = $('inc');
  inc.onchange = () => nav({ inc: inc.value.trim() });
  inc.onkeydown = (e) => e.key === 'Enter' && inc.blur();

  const token = ++searchToken;
  const qs = new URLSearchParams({ q: w.q, scope: here ? w.folder : '', include: w.inc || '' });
  if (opts.includes('c')) qs.set('case', '1');
  if (opts.includes('w')) qs.set('word', '1');
  if (opts.includes('r')) qs.set('regex', '1');
  let r;
  try {
    r = await api('api/search?' + qs);
  } catch (err) {
    if (token === searchToken) $('results').innerHTML = `<p class="note">${esc(err.message)}</p>`;
    return;
  }
  if (token !== searchToken) return;
  if (r.error) {
    $('results').innerHTML = `<p class="note">${esc(r.error)}</p>`;
    return;
  }
  const names = r.files.filter((f) => f.name);
  const withLines = r.files.filter((f) => f.matches.length);
  const nLines = withLines.reduce((n, f) => n + f.matches.length, 0);
  const summary = `${nLines.toLocaleString()} matching lines in ${withLines.length.toLocaleString()} files${names.length ? ` · ${names.length} file names` : ''} · searched ${r.searched.toLocaleString()} files in ${r.ms} ms${r.truncated ? ' · stopped early, narrow the search' : ''}`;
  const nameList = names.length
    ? `<section class="sgroup"><h3 class="group-title">Files named like this</h3><div class="rows">${names
        .slice(0, 100)
        .map((f) => `<a class="row" href="${fileHref(f.path)}"><span class="ico">${icon('file', 18)}</span><span class="nm">${esc(f.path)}</span><span class="marks">${badge(stateOf(f.path, 'file'))}</span></a>`)
        .join('')}</div></section>`
    : '';
  const hits = withLines
    .map((f) => {
      const st = stateOf(f.path, 'file');
      return `<section class="sfile"><h3 class="group-title"><a href="${fileHref(f.path)}">${esc(f.path)}</a>${badge(st)}<span class="faint">${f.matches.length}</span></h3><div class="slines">${f.matches
        .map((m) => `<a class="sline" href="${fileHref(f.path, { line: String(m.line) })}"><span class="sn">${m.line}</span><code>${mark(m.text, m.hits)}</code></a>`)
        .join('')}</div></section>`;
    })
    .join('');
  $('results').innerHTML = `<p class="meta">${summary}</p>${nameList}${hits || (names.length ? '' : '<p class="empty">Nothing found.</p>')}`;
}

// ── quick open ──
let files = null;
export const forgetFiles = () => (files = null);

function score(q, s) {
  // a subsequence match; earlier, consecutive and after-a-slash hits score higher, and the name more than the path
  const lq = q.toLowerCase(),
    ls = s.toLowerCase();
  const nameAt = ls.lastIndexOf('/') + 1;
  let si = 0,
    total = 0,
    run = 0;
  const hits = [];
  for (const c of lq) {
    if (c === ' ') continue;
    const i = ls.indexOf(c, si);
    if (i < 0) return null;
    run = i === si ? run + 1 : 0;
    total += 1 + run * 2 + (i === 0 || '/._-'.includes(ls[i - 1]) ? 3 : 0) + (i >= nameAt ? 2 : 0);
    hits.push(i);
    si = i + 1;
  }
  if (ls.slice(nameAt).startsWith(lq)) total += 10;
  return { total: total - s.length * 0.02, hits };
}

export async function quickOpen() {
  if ($('qo')) return;
  const box = document.createElement('div');
  box.id = 'qo';
  box.className = 'modal-back';
  box.innerHTML = `<div class="modal qo" role="dialog" aria-label="Go to a file"><label class="qo-in">${icon('search')}<input id="qo-in" placeholder="Go to a file or folder…" autocomplete="off" spellcheck="false" enterkeyhint="go"></label><div id="qo-list" class="qo-list"><p class="note">Loading…</p></div><div class="qo-foot faint">↑↓ to move · Enter to open · Esc to close · type <b>?</b> then words to search inside files</div></div>`;
  document.body.append(box);
  const input = $('qo-in'),
    list = $('qo-list');
  input.focus();
  const close = () => box.remove();
  box.onclick = (e) => e.target === box && close();
  if (!files) {
    const fl = (await api('api/files')).files;
    const dirs = new Set();
    for (const f of fl) for (let p = parentOf(f); p && !dirs.has(p); p = parentOf(p)) dirs.add(p);
    files = [...fl, ...[...dirs].map((d) => d + '/')];
  }
  let items = [],
    at = 0;
  const draw = () => {
    const q = input.value.trim();
    if (q.startsWith('?')) {
      items = q.length > 1 ? [{ search: q.slice(1).trim() }] : [];
      list.innerHTML = items.length ? `<button class="qo-item on" data-i="0">${icon('search', 16)} Search everywhere for “${esc(items[0].search)}”</button>` : '<p class="note">Type what to search for.</p>';
      at = 0;
      return;
    }
    if (!q) items = files.filter((f) => !f.endsWith('/')).slice(0, 60).map((p) => ({ p, hits: [] }));
    else
      items = files
        .map((p) => ({ p, s: score(q, p) }))
        .filter((x) => x.s)
        .sort((a, b) => b.s.total - a.s.total)
        .slice(0, 60)
        .map((x) => ({ p: x.p, hits: x.s.hits }));
    at = Math.min(at, Math.max(0, items.length - 1));
    list.innerHTML = items.length
      ? items
          .map((it, i) => {
            const set = new Set(it.hits);
            const txt = [...it.p].map((c, j) => (set.has(j) ? `<b>${esc(c)}</b>` : esc(c))).join('');
            const dir = it.p.endsWith('/');
            const st = stateOf(dir ? it.p.slice(0, -1) : it.p, dir ? 'folder' : 'file');
            return `<button class="qo-item${i === at ? ' on' : ''}${st ? ' s-' + st : ''}" data-i="${i}">${icon(dir ? 'folder' : 'file', 16)}<span class="nm">${txt}</span>${badge(st, dir)}</button>`;
          })
          .join('')
      : '<p class="note">No file matches. Start with ? to search inside files.</p>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    if (it.search) go({ m: 'search', q: it.search });
    else if (it.p.endsWith('/')) go({ folder: it.p.slice(0, -1) });
    else location.hash = fileHref(it.p);
  };
  input.oninput = debounce(() => {
    at = 0;
    draw();
  }, 30);
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      list.querySelectorAll('.qo-item').forEach((b, i) => b.classList.toggle('on', i === at));
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  list.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (b) pick(Number(b.dataset.i));
  };
  draw();
}
