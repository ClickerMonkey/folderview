// What the page knows: the address (route), folder listings, git's state and the review comments.
import { api, coll, parentOf, store } from './util.js';

export const state = {
  info: { name: '', git: false, author: '', readOnly: false, review: { json: '', md: '' } },
  /** folder path → entries */
  cache: new Map(),
  /** git status (or null outside a repo) */
  git: null,
  /** path → change */
  changes: new Map(),
  /** folder path → the most important state of anything below it */
  folderStates: new Map(),
  ignored: [],
  comments: [],
  settings: {
    theme: store('theme') || 'auto',
    ignored: store('ignored') || 'dim', // dim | hide
    wrap: store('wrap') === '1',
    review: store('review') === '1',
    resolved: store('resolved') !== '0', // show resolved threads inline
    author: store('author') || '',
  },
};

export function setSetting(k, v) {
  state.settings[k] = v;
  store(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
}

export const author = () => state.settings.author || state.info.author || 'reviewer';

// ── the address: #/folder/path?open=name&m=search&q=…&line=12&tab=diff&view=grid ──
const KEYS = ['open', 'view', 'm', 'q', 'show', 'scope', 'line', 'tab', 'opts', 'inc'];
export function where() {
  const h = location.hash.slice(1) || '/';
  const qi = h.indexOf('?');
  const p = decodeURIComponent(qi < 0 ? h : h.slice(0, qi));
  const qs = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1));
  const r = { folder: p.replace(/^\/+|\/+$/g, '') };
  for (const k of KEYS) r[k] = qs.get(k) || '';
  return r;
}
export function href(r) {
  const qs = new URLSearchParams();
  for (const k of KEYS) if (r[k]) qs.set(k, r[k]);
  const q = qs.toString();
  return '#/' + (r.folder || '').split('/').map(encodeURIComponent).join('/') + (q ? '?' + q : '');
}
/** go to a place: a fresh route that keeps only the folder view preference */
export function go(r) {
  location.hash = href({ view: where().view, ...r });
}
/** change part of the current route */
export function nav(patch, replace = false) {
  const h = href({ ...where(), ...patch });
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
}
/** the route that opens a file (optionally at a line) */
export const fileHref = (path, extra = {}) => href({ folder: parentOf(path), open: path.slice(path.lastIndexOf('/') + 1), ...extra });

// ── folders ──
export const sortEntries = (es) => [...es].sort((a, b) => (b.type === 'folder') - (a.type === 'folder') || coll.compare(a.name, b.name));
export async function load(p) {
  if (state.cache.has(p)) return state.cache.get(p);
  const j = await api('api/list?p=' + encodeURIComponent(p));
  const e = sortEntries(j.entries);
  state.cache.set(p, e);
  return e;
}

// ── git ──
const RANK = { conflict: 6, deleted: 5, modified: 4, renamed: 3, added: 2, new: 1 };
export async function loadGit() {
  if (!state.info.git) return;
  try {
    const s = await api('api/git/status');
    state.git = s;
    state.changes = new Map(s.changes.map((c) => [c.path, c]));
    state.ignored = s.ignored;
    const fs = new Map();
    for (const c of s.changes) {
      let p = parentOf(c.path);
      for (;;) {
        const cur = fs.get(p);
        if (!cur || RANK[c.state] > RANK[cur]) fs.set(p, c.state);
        if (!p) break;
        p = parentOf(p);
      }
    }
    state.folderStates = fs;
  } catch {
    state.git = null;
  }
}
export function isIgnored(path) {
  for (const i of state.ignored) {
    if (i.endsWith('/') ? path === i.slice(0, -1) || path.startsWith(i) : path === i) return true;
  }
  return false;
}
export const LETTER = { new: 'U', added: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflict: '!' };
export const LABEL = { new: 'New (untracked)', added: 'Added', modified: 'Changed', deleted: 'Deleted', renamed: 'Renamed', conflict: 'Conflict', ignored: 'Ignored' };

// ── comments ──
export async function loadComments() {
  try {
    state.comments = (await api('api/comments')).comments;
  } catch {
    state.comments = [];
  }
}
export const commentsOn = (path) => state.comments.filter((c) => c.path === path);
export function openCommentsUnder(folder) {
  const pre = folder ? folder + '/' : '';
  return state.comments.filter((c) => c.status === 'open' && (c.path === folder || c.path.startsWith(pre))).length;
}
