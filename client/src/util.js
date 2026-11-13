// Small helpers shared by every part of the page.
export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const extOf = (n) => {
  const b = baseOf(n);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
export const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
export const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const join = (...p) => p.filter(Boolean).join('/');
export const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (p) => 'raw/' + encPath(p);

export function norm(p) {
  const o = [];
  for (const s of p.split('/')) {
    if (s === '..') o.pop();
    else if (s && s !== '.') o.push(s);
  }
  return o.join('/');
}

export const size = (b) =>
  b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';

export const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
};

export const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem('folderview:' + k);
    if (v === null) localStorage.removeItem('folderview:' + k);
    else localStorage.setItem('folderview:' + k, v);
  } catch {
    return null;
  }
}

export async function api(url, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['content-type'] = 'application/json';
    delete init.json;
  }
  const r = await fetch(url, init);
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || (typeof data === 'string' && data) || r.statusText);
  return data;
}

export async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast(what);
}

let toastTimer;
export function toast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** a tiny event bus */
const handlers = new Map();
export const on = (type, fn) => (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn);
export const emit = (type, data) => handlers.get(type)?.forEach((fn) => fn(data));

/** a path as HTML that may break after each slash, so a long one wraps at its folders */
export const pathHtml = (p) => esc(p).replaceAll('/', '/<wbr>');
