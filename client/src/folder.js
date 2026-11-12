// A folder: the trail, filter, list or thumbnails, git colours, comment counts, a zip download, and its README below.
import { $, ago, api, esc, extOf, join, rawUrl, size, store } from './util.js';
import { LABEL, LETTER, isIgnored, load, nav, go, openCommentsUnder, state, where } from './state.js';
import { renderMarkdown } from './markdown.js';
import { IMG } from './file.js';
import { focusSearch } from './search.js';
import { icon } from './icons.js';

export let filter = '';
export const clearFilter = () => (filter = '');
let sortBy = store('sort') || 'name';

const KNOWN = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'md', 'mdx', 'json', 'css', 'scss', 'html', 'vue', 'py', 'rs', 'go']);
const KIND_ICON = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', mp3: 'music', wav: 'music', ogg: 'music', mp4: 'video', webm: 'video', mov: 'video', csv: 'table', tsv: 'table', pdf: 'book', zip: 'layers', gz: 'layers' };

export function icon16(e, folder) {
  if (e.type === 'folder') return `<span class="ico folder">${icon('folder', 18)}</span>`;
  const x = extOf(e.name);
  if (IMG.has(x) && e.size < 4 * 1048576 && !e.ghost) return `<span class="ico"><img loading="lazy" src="${rawUrl(join(folder, e.name))}" alt=""></span>`;
  if (KNOWN.has(x)) return `<span class="ico lang-${x}"><span class="ext">${esc(x.slice(0, 4))}</span></span>`;
  return `<span class="ico">${icon(KIND_ICON[x] || 'file', 18)}</span>`;
}

/** the git state of an entry: its own, or the most important one below a folder */
export function stateOf(path, type) {
  if (type === 'folder') return state.folderStates.get(path) || (isIgnored(path) ? 'ignored' : '');
  return state.changes.get(path)?.state || (isIgnored(path) ? 'ignored' : '');
}

export function badge(st, folder) {
  if (!st || (st === 'ignored' && !folder)) return ''; // ignored files are already dimmed
  if (folder) return st === 'ignored' ? '' : `<span class="dot s-${st}" title="Something inside is ${LABEL[st].toLowerCase()}"></span>`;
  return `<span class="badge s-${st}" title="${LABEL[st]}">${LETTER[st] || '·'}</span>`;
}

function sorted(es) {
  const dirsFirst = (a, b) => (b.type === 'folder') - (a.type === 'folder');
  if (sortBy === 'size') return [...es].sort((a, b) => dirsFirst(a, b) || b.size - a.size);
  if (sortBy === 'mtime') return [...es].sort((a, b) => dirsFirst(a, b) || b.mtime - a.mtime);
  return es;
}

/** README text by path and modified time, so a redraw shows it at once (no "Loading…" flash) */
const readmes = new Map();

export async function renderFolder(m) {
  const { folder, open, view } = where();
  let es;
  try {
    es = await load(folder);
  } catch (err) {
    m.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  // files git says were deleted still show, struck through, so their diff can be opened
  const ghosts = [...state.changes.values()]
    .filter((c) => c.state === 'deleted' && (c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '') === folder)
    .map((c) => ({ name: c.path.slice(c.path.lastIndexOf('/') + 1), type: 'file', size: 0, mtime: 0, ghost: true }))
    .filter((g) => !es.some((e) => e.name === g.name));
  let all = [...es, ...ghosts];
  if (state.settings.ignored === 'hide') all = all.filter((e) => !isIgnored(join(folder, e.name)));
  const imgs = all.filter((e) => IMG.has(extOf(e.name))).length;
  const grid = view ? view === 'grid' : imgs >= 4 && imgs >= all.length / 2;
  const shown = sorted(filter ? all.filter((e) => e.name.toLowerCase().includes(filter)) : all);
  const parts = folder ? folder.split('/') : [];
  const crumbs = [
    `<button class="crumb${parts.length ? '' : ' current'}" data-f="">${esc(state.info.name)}</button>`,
    ...parts.map((p, i) => `<span class="sep">/</span><button class="crumb${i === parts.length - 1 ? ' current' : ''}" data-f="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`),
  ].join('');
  const nF = all.filter((e) => e.type === 'folder').length;
  const row = (e) => {
    const p = join(folder, e.name);
    const st = e.ghost ? 'deleted' : stateOf(p, e.type);
    const nc = openCommentsUnder(p);
    const cls = ['row', e.name === open ? 'open' : '', st ? 's-' + st : '', e.ghost ? 'ghost' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-e="${esc(e.name)}" data-k="${e.type}" title="${esc(e.name)}${st ? ' · ' + LABEL[st] : ''}">${icon16(e, folder)}<span class="nm">${esc(e.name)}${e.link ? ' <span class="faint">↪</span>' : ''}</span><span class="marks">${nc ? `<span class="pill warn">${icon('chat', 12)}${nc}</span>` : ''}${badge(st, e.type === 'folder')}</span><span class="sz">${e.type === 'folder' || e.ghost ? '' : size(e.size)}</span><span class="tm">${e.ghost ? 'deleted' : ago(e.mtime)}</span></button>`;
  };
  const tile = (e) => {
    const p = join(folder, e.name);
    const x = extOf(e.name);
    const st = e.ghost ? 'deleted' : stateOf(p, e.type);
    const th = e.type === 'folder' ? icon('folder', 34) : IMG.has(x) && !e.ghost ? `<img loading="lazy" src="${rawUrl(p)}" alt="">` : `<span class="ext">.${esc(x || 'file')}</span>`;
    return `<button class="tile${e.name === open ? ' open' : ''}${st ? ' s-' + st : ''}" data-e="${esc(e.name)}" data-k="${e.type}" title="${esc(e.name)}"><div class="thumb">${th}${badge(st, e.type === 'folder')}</div><div class="nm">${esc(e.name)}</div></button>`;
  };
  const body = !shown.length
    ? `<p class="empty">${filter ? 'Nothing matches.' : 'Nothing in this folder.'}</p>`
    : grid
      ? `<div class="grid">${shown.map(tile).join('')}</div>`
      : `<div class="rows">${shown.map(row).join('')}</div>`;
  const readme = es.find((e) => /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name) && e.type === 'file');
  const zipName = (folder ? parts[parts.length - 1] : state.info.name) + '.zip';
  m.innerHTML = `<header class="head"><nav class="crumbs" aria-label="Folder trail">${crumbs}</nav>
    <a class="icon-btn" href="api/zip?p=${encodeURIComponent(folder)}" download="${esc(zipName)}" title="Download this folder as a .zip" aria-label="Download this folder as a .zip">${icon('download')}</a></header>
  <div class="head"><input class="filter" id="filter" type="search" placeholder="Filter this folder" value="${esc(filter)}" aria-label="Filter this folder">
    <div class="tools"><span class="seg"><button class="btn${grid ? '' : ' on'}" data-v="list" title="List" aria-label="List">${icon('list', 16)}</button><button class="btn${grid ? ' on' : ''}" data-v="grid" title="Thumbnails" aria-label="Thumbnails">${icon('grid', 16)}</button></span>
    <select class="btn" id="sort" aria-label="Sort by"><option value="name"${sortBy === 'name' ? ' selected' : ''}>Name</option><option value="mtime"${sortBy === 'mtime' ? ' selected' : ''}>Newest</option><option value="size"${sortBy === 'size' ? ' selected' : ''}>Largest</option></select>
    <button class="btn" id="search-here" title="Search inside this folder">${icon('search', 16)}<span class="hide-sm">Search here</span></button></div>
    <span class="meta">${nF} folders · ${all.length - nF} files</span></div>
  ${body}
  ${readme && !open ? `<section class="card readme"><div class="card-head">${icon('book', 16)} ${esc(readme.name)}</div><article class="md" id="readme"></article></section>` : ''}`;
  const f = $('filter');
  f.oninput = () => {
    filter = f.value.toLowerCase();
    const at = f.selectionStart;
    renderFolder(m).then(() => {
      const g = $('filter');
      g.focus();
      g.setSelectionRange(at, at);
    });
  };
  f.onkeydown = (e) => {
    if (e.key === 'Enter') m.querySelector('[data-e]')?.click();
  };
  $('sort').onchange = (e) => {
    sortBy = e.target.value;
    store('sort', sortBy);
    renderFolder(m);
  };
  $('search-here').onclick = () => focusSearch('here');
  if (readme && !open) {
    const p = join(folder, readme.name);
    const key = p + '@' + readme.mtime;
    const draw = (t) => {
      const r = $('readme');
      if (!r || where().folder !== folder) return;
      if (/\.txt$/i.test(readme.name) || !/\./.test(readme.name)) r.innerHTML = `<pre>${esc(t)}</pre>`;
      else renderMarkdown(r, String(t), folder);
    };
    if (readmes.has(key)) draw(readmes.get(key));
    else {
      $('readme').innerHTML = '<div class="skeleton" style="width:50%"></div>';
      api(rawUrl(p))
        .then((t) => {
          readmes.set(key, String(t));
          draw(String(t));
        })
        .catch((err) => {
          const r = $('readme');
          if (r) r.innerHTML = `<p class="note">${esc(err.message)}</p>`;
        });
    }
  }
}

export function wireFolder(m) {
  m.addEventListener('click', (e) => {
    const t = e.target;
    const f = t.closest('[data-f]'),
      en = t.closest('[data-e]'),
      v = t.closest('[data-v]');
    const w = where();
    if (f) {
      filter = '';
      go({ folder: f.dataset.f });
    } else if (v) nav({ view: v.dataset.v });
    else if (en) {
      if (en.dataset.k === 'folder') {
        filter = '';
        go({ folder: join(w.folder, en.dataset.e) });
      } else go({ folder: w.folder, open: en.dataset.e });
    }
  });
}
