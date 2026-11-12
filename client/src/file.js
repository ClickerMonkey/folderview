// The opened file: a header, tabs that depend on its kind, and a viewer for each kind.
import { $, api, ago, copy, esc, extOf, join, rawUrl, size } from './util.js';
import { LABEL, LETTER, commentsOn, href, isIgnored, load, nav, state, where } from './state.js';
import { paintMarks, wireImage } from './ink.js';
import { codeBlockHtml, renderMarkdown } from './markdown.js';
import { diffMarks, parseDiff, placeDiffThreads, placeThreads, renderCode, renderDiff } from './code.js';
import { composerHtml, fileThreadsHtml } from './review.js';
import { langOf } from './shiki.js';
import { drawInto } from './mermaid.js';
import { icon } from './icons.js';

const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);
const AUD = new Set(['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'aac', 'opus']);
const VID = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const FONT = new Set(['woff', 'woff2', 'ttf', 'otf']);
const BIN = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'glb', 'fbx', 'blend', 'vox', 'wasm', 'class', 'jar', 'o', 'a', 'pyc', 'db', 'sqlite', 'psd', 'ai', 'sketch', 'fig', 'xlsx', 'docx', 'pptx', 'ktx2', 'basis', 'dds', 'hdr', 'exr', 'mid', 'midi']);
const TABLE = { csv: ',', tsv: '\t' };
const maxText = () => state.info.maxFile || 5 * 1048576;
export const downloadUrl = (p) => rawUrl(p) + '?download=1';
/** on a phone the page scrolls, not the pane */
const scroller = (el) => (matchMedia('(max-width: 759px)').matches ? document.scrollingElement : el);

export { IMG };

/** what kind of file this is, which decides the tabs */
export function kindOf(name) {
  const x = extOf(name);
  if (x === 'svg') return 'svg';
  if (IMG.has(x)) return 'image';
  if (AUD.has(x)) return 'audio';
  if (VID.has(x)) return 'video';
  if (FONT.has(x)) return 'font';
  if (x === 'pdf') return 'pdf';
  if (BIN.has(x)) return 'binary';
  if (x === 'md' || x === 'markdown' || x === 'mdx') return 'markdown';
  if (x === 'html' || x === 'htm') return 'html';
  if (x === 'ipynb') return 'notebook';
  if (x === 'mmd' || x === 'mermaid') return 'diagram';
  if (x in TABLE) return 'table';
  if (x === 'json' || x === 'geojson' || x === 'webmanifest' || x === 'gltf') return 'json';
  return 'text';
}

const PREVIEW_NAME = { image: 'Image', svg: 'Image', audio: 'Player', video: 'Player', font: 'Font', pdf: 'PDF', markdown: 'Rendered', html: 'Preview', notebook: 'Notebook', table: 'Table', json: 'Tree', binary: 'Hex', diagram: 'Diagram' };
const HAS_SOURCE = new Set(['svg', 'markdown', 'html', 'notebook', 'table', 'json', 'text', 'diagram']);

let current = { path: '', token: 0 };

export function closeFile() {
  current = { path: '', token: current.token + 1 };
}

export async function renderFile(el, force = false) {
  const { folder, open, tab } = where();
  const path = join(folder, open);
  if (!force && current.path === path && current.tab === (tab || '')) {
    // same file and tab: just move the line selection
    return;
  }
  const sc = scroller(el);
  const keepScroll = force && current.path === path ? sc.scrollTop : 0;
  const token = ++current.token;
  current = { path, tab: tab || '', token };

  const es = state.cache.get(folder) || [];
  const e = es.find((x) => x.name === open);
  const change = state.changes.get(path);
  const deleted = !e && change?.state === 'deleted';
  const kind = kindOf(open);
  const tabs = [];
  if (deleted) tabs.push(['deleted', 'Last committed']);
  else {
    if (PREVIEW_NAME[kind]) tabs.push(['preview', PREVIEW_NAME[kind]]);
    if (HAS_SOURCE.has(kind)) tabs.push(['source', 'Source']);
  }
  if (change && change.state !== 'ignored') tabs.push(['diff', 'Changes']);
  if (change && (kind === 'image' || kind === 'svg') && change.state !== 'new' && change.state !== 'added') tabs.push(['compare', 'Compare']);
  if (state.git && change?.state !== 'new' && !isIgnored(path)) tabs.push(['history', 'History']);
  const active = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0] || 'source';

  const url = rawUrl(path);
  const st = change && change.state !== 'ignored' ? change.state : '';
  const nCom = commentsOn(path).filter((c) => c.status === 'open').length;
  if (!state.cache.has(folder)) {
    await load(folder).catch(() => []);
    if (token !== current.token) return;
  }
  const [prev, next] = neighbours(folder, open);
  const head = `<header class="file-head">
    <button class="icon-btn back" id="back" aria-label="Back to the folder" title="Back to the folder">${icon('chevron-left')}</button>
    <span class="file-name" title="${esc(path)}">${esc(open)}</span>
    ${st ? `<span class="badge s-${st}" title="${LABEL[st]}">${LETTER[st] || '·'}</span>` : ''}
    ${nCom ? `<span class="pill warn" title="Open comments">${icon('chat', 12)} ${nCom}</span>` : ''}
    <span class="grow"></span>
    <button class="icon-btn" id="prev-file" ${prev ? `title="Previous: ${esc(prev)} ( [ )" aria-label="Previous file: ${esc(prev)}"` : 'disabled title="No previous file" aria-label="No previous file"'}>${icon('arrow-left')}</button>
    <button class="icon-btn" id="next-file" ${next ? `title="Next: ${esc(next)} ( ] )" aria-label="Next file: ${esc(next)}"` : 'disabled title="No next file" aria-label="No next file"'}>${icon('arrow-right')}</button>
    <button class="icon-btn hide-sm" id="copy-path" title="Copy the path" aria-label="Copy the path">${icon('link')}</button>
    ${state.info.readOnly ? '' : `<button class="icon-btn" id="comment-file" title="Comment on the whole file" aria-label="Comment on the whole file">${icon('chat')}</button>`}
    ${deleted ? '' : `<a class="icon-btn" href="${downloadUrl(path)}" download="${esc(open)}" title="Download" aria-label="Download">${icon('download')}</a><a class="icon-btn hide-sm" href="${url}" target="_blank" rel="noopener" title="Open the raw file" aria-label="Open the raw file">${icon('external')}</a>`}
    <button class="icon-btn" id="close" aria-label="Close the file" title="Close (Esc)">${icon('x')}</button>
  </header>
  <div class="meta" id="fmeta">${esc(path)}${e ? ' · ' + size(e.size) + ' · ' + ago(e.mtime) : deleted ? ' · deleted' : ''}${change?.add !== undefined ? ` · <span class="plus">+${change.add}</span> <span class="minus">−${change.del || 0}</span>` : ''}</div>
  <div id="file-threads">${fileThreadsHtml(path, folder)}</div>
  ${tabs.length > 1 ? `<div class="tabs">${tabs.map(([k, label]) => `<button class="btn${k === active ? ' on' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>` : ''}
  <div id="fbody"><div class="skeleton" style="width:70%"></div></div>`;
  el.innerHTML = head;
  sc.scrollTop = 0;
  $('close').onclick = () => nav({ open: '', tab: '', line: '' });
  $('back').onclick = () => nav({ open: '', tab: '', line: '' });
  $('copy-path').onclick = () => copy(path, 'Path copied');
  $('prev-file').onclick = () => step(-1);
  $('next-file').onclick = () => step(1);
  const cf = $('comment-file');
  if (cf)
    cf.onclick = () => {
      if ($('file-threads').querySelector('.composer')) return;
      $('file-threads').insertAdjacentHTML('beforeend', composerHtml(path, 0, 0));
      $('file-threads').querySelector('.composer textarea').focus();
    };
  el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => nav({ tab: b.dataset.tab === tabs[0][0] ? '' : b.dataset.tab, line: '' })));

  const body = $('fbody');
  const stale = () => token !== current.token;
  try {
    await viewer(active, { body, path, folder, kind, url, e, change, stale });
  } catch (err) {
    if (!stale()) body.innerHTML = `<p class="note">${esc(err.message)}</p>`;
  }
  if (keepScroll && !stale()) sc.scrollTop = keepScroll;
}

/** the files before and after this one in its folder, by name (folders and hidden ignored files skipped) */
function neighbours(folder, name) {
  let files = (state.cache.get(folder) || []).filter((e) => e.type !== 'folder');
  if (state.settings.ignored === 'hide') files = files.filter((e) => !isIgnored(join(folder, e.name)));
  const i = files.findIndex((e) => e.name === name);
  if (i < 0) return ['', ''];
  return [files[i - 1]?.name || '', files[i + 1]?.name || ''];
}

/** open the previous (-1) or next (1) file in the folder */
export function step(dir) {
  const { folder, open } = where();
  if (!open) return;
  const target = neighbours(folder, open)[dir < 0 ? 0 : 1];
  if (target) nav({ open: target, tab: '', line: '' });
}

/** comments changed: redraw the threads in place (keeps scroll and drafts elsewhere) */
export function refreshFileThreads(el) {
  const { folder, open } = where();
  const t = el.querySelector('#file-threads');
  if (!t || !open) return;
  const draft = t.querySelector('.composer');
  t.innerHTML = fileThreadsHtml(join(folder, open), folder);
  if (draft) t.append(draft);
  placeThreads(el.querySelector('#fbody > .code, #fbody .code:not(.diff)'));
  placeDiffThreads(el.querySelector('.diff'));
  paintMarks();
}

async function viewer(tab, ctx) {
  const { body, path, folder, kind, url, e, stale } = ctx;
  const rawText = async () => {
    if (e && e.size > maxText()) throw new Error(`Too large to show here (${size(e.size)}). Download it instead.`);
    const r = await fetch(url);
    return r.text();
  };

  if (tab === 'diff') {
    const d = await api('api/git/diff?p=' + encodeURIComponent(path));
    if (stale()) return;
    renderDiff(body, d, path, { caption: 'Changes since the last commit' });
    return;
  }
  if (tab === 'deleted') {
    const t = await api('api/git/show?p=' + encodeURIComponent(path));
    if (stale()) return;
    body.innerHTML = '<p class="note">This file was deleted. It looked like this at the last commit:</p><div id="code-host"></div>';
    renderCode($('code-host'), { path, text: t, folder });
    return;
  }
  if (tab === 'history') return history(body, path, stale);
  if (tab === 'compare') {
    body.innerHTML = `<div class="compare"><figure><figcaption>Last commit</figcaption><div class="stage"><img src="api/git/raw?p=${encodeURIComponent(path)}" alt="Before"></div></figure><figure><figcaption>Now</figcaption><div class="stage"><img src="${url}?t=${Date.now()}" alt="After"></div></figure></div>`;
    return;
  }
  if (tab === 'source' || kind === 'text') {
    const t = await rawText();
    if (stale()) return;
    if (t.includes('\u0000')) return hex(body, url, stale);
    const fresh = ctx.change?.state === 'new' || ctx.change?.state === 'added';
    body.innerHTML = '<div id="code-host"></div>';
    const code = renderCode($('code-host'), { path, text: t, folder, marks: fresh ? new Map(t.split('\n').map((_, i) => [i + 1, 'add'])) : undefined, download: downloadUrl(path) });
    // the change bars beside changed lines arrive with the diff, after the code is already on screen
    if (ctx.change && !fresh && ctx.change.state !== 'ignored') {
      const d = await api('api/git/diff?p=' + encodeURIComponent(path)).catch(() => '');
      if (stale() || !code.isConnected) return;
      for (const [n, mk] of diffMarks(parseDiff(d))) code.querySelector(`.ln[data-n="${n}"] .mk`)?.classList.add(mk);
    }
    return;
  }

  // the previews
  switch (kind) {
    case 'image':
    case 'svg': {
      body.innerHTML = `<div class="stage" id="stage"><div class="picwrap" id="picwrap"><img id="pic" src="${url}?t=${e ? e.mtime : 0}" alt="${esc(path)}" draggable="false"><svg class="marks" id="marks" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><div class="pins" id="pins"></div></div></div><div class="img-tools" id="img-tools"></div>`;
      const pic = $('pic');
      wireImage({ path, stage: $('stage'), pic, tools: $('img-tools'), step });
      pic.onload = () => {
        const m = $('fmeta');
        if (m && !m.dataset.dim) {
          m.dataset.dim = '1';
          m.insertAdjacentHTML('beforeend', ` · ${pic.naturalWidth} × ${pic.naturalHeight}`);
        }
      };
      return;
    }
    case 'audio':
      body.innerHTML = `<div class="stage"><audio controls preload="metadata" src="${url}"></audio></div>`;
      return;
    case 'video':
      body.innerHTML = `<div class="stage"><video controls preload="metadata" src="${url}"></video></div>`;
      return;
    case 'pdf':
      body.innerHTML = `<div class="stage"><iframe src="${url}" title="${esc(path)}"></iframe></div>`;
      return;
    case 'font':
      return font(body, url);
    case 'binary':
      return hex(body, url, stale);
    case 'markdown': {
      const t = await rawText();
      if (stale()) return;
      body.innerHTML = '<article class="md card"></article>';
      renderMarkdown(body.firstElementChild, t, folder);
      return;
    }
    case 'diagram': {
      const t = await rawText();
      if (stale()) return;
      body.innerHTML = '<div class="stage diagram"></div>';
      await drawInto(body.firstElementChild, t);
      return;
    }
    case 'html':
      body.innerHTML = `<p class="faint hint">Shown sandboxed: scripts don't run.</p><div class="stage page"><iframe sandbox="" src="${url}?as=page" title="${esc(path)}"></iframe></div>`;
      return;
    case 'table': {
      const t = await rawText();
      if (stale()) return;
      return table(body, t, TABLE[extOf(path)]);
    }
    case 'json': {
      const t = await rawText();
      if (stale()) return;
      let data;
      try {
        data = JSON.parse(t);
      } catch (err) {
        body.innerHTML = `<p class="note">Not valid JSON: ${esc(err.message)}</p>`;
        return;
      }
      body.innerHTML = `<div class="code-foot"><button class="btn small" data-jt="open">Expand all</button><button class="btn small" data-jt="close">Collapse all</button></div><div class="jtree">${jsonTree(data, 0)}</div>`;
      body.querySelectorAll('[data-jt]').forEach((b) => (b.onclick = () => body.querySelectorAll('.jtree details').forEach((d) => (d.open = b.dataset.jt === 'open'))));
      return;
    }
    case 'notebook': {
      const t = await rawText();
      if (stale()) return;
      return notebook(body, t, folder);
    }
  }
}

async function history(body, path, stale) {
  const { commits, more } = await api('api/git/log?p=' + encodeURIComponent(path));
  if (stale()) return;
  if (!commits.length) {
    body.innerHTML = '<p class="note">No commits touch this file yet.</p>';
    return;
  }
  const row = (c) => `<button class="commit" data-h="${esc(c.hash)}"><code>${esc(c.hash)}</code><span class="subj">${esc(c.subject)}</span><span class="faint">${esc(c.author)} · ${ago(c.time)}</span></button>`;
  body.innerHTML = `<div class="commits">${commits.map(row).join('')}</div>${more ? '<button class="btn small" id="log-more">Show older commits</button>' : ''}<div id="commit-diff"></div>`;
  let shown = commits.length;
  const moreBtn = $('log-more');
  if (moreBtn)
    moreBtn.onclick = async () => {
      moreBtn.disabled = true;
      const next = await api(`api/git/log?p=${encodeURIComponent(path)}&skip=${shown}`).catch(() => null);
      if (stale() || !next) return void (moreBtn.disabled = false);
      shown += next.commits.length;
      body.querySelector('.commits').insertAdjacentHTML('beforeend', next.commits.map(row).join(''));
      if (next.more) moreBtn.disabled = false;
      else moreBtn.remove();
    };
  // one handler for every row, old ones loaded later included
  body.querySelector('.commits').onclick = (e) => {
    const b = e.target.closest('[data-h]');
    if (b) showCommit(b).catch(() => {});
  };
  async function showCommit(b) {
    body.querySelectorAll('.commit').forEach((x) => x.classList.toggle('on', x === b));
    const d = await api(`api/git/commit?p=${encodeURIComponent(path)}&h=${b.dataset.h}`);
    if (stale()) return;
    renderDiff($('commit-diff'), d, path, { comments: false, caption: b.dataset.h });
    $('commit-diff').insertAdjacentHTML('afterbegin', `<a class="btn small" href="${href({ folder: where().folder, m: 'history', q: b.dataset.h })}">${icon('diff', 14)} The whole commit</a>`);
    $('commit-diff').scrollIntoView({ block: 'nearest' });
  }
}

async function hex(body, url, stale) {
  const r = await fetch(url, { headers: { range: 'bytes=0-8191' } });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (stale()) return;
  const rows = [];
  for (let i = 0; i < buf.length; i += 16) {
    const b = [...buf.slice(i, i + 16)];
    const hx = b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const asc = b.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    rows.push(`<span class="faint">${i.toString(16).padStart(8, '0')}</span>  ${hx.padEnd(47)}  ${esc(asc)}`);
  }
  body.innerHTML = `<p class="faint hint">No preview for this kind of file. The first ${buf.length.toLocaleString()} bytes:</p><pre class="hex">${rows.join('\n')}</pre>`;
}

async function font(body, url) {
  const name = 'fs-font-' + Math.random().toString(36).slice(2);
  const face = new FontFace(name, `url("${url}")`);
  try {
    await face.load();
    document.fonts.add(face);
  } catch {
    body.innerHTML = '<p class="note">This font could not be loaded.</p>';
    return;
  }
  const sample = 'The quick brown fox jumps over the lazy dog';
  body.innerHTML = `<div class="font" style="font-family:'${name}'">
    <input class="font-sample" value="${sample}" aria-label="Sample text">
    ${[64, 40, 28, 20, 14].map((s) => `<p style="font-size:${s}px" data-s>${sample}</p>`).join('')}
    <p style="font-size:22px">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !@#$%^&amp;*()[]{}?</p></div>`;
  body.querySelector('.font-sample').oninput = (ev) => body.querySelectorAll('[data-s]').forEach((p) => (p.textContent = ev.target.value || sample));
}

function parseDelimited(t, sep) {
  const rows = [];
  let row = [],
    cell = '',
    q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > 5000) break;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function table(body, t, sep) {
  const rows = parseDelimited(t, sep);
  if (!rows.length) {
    body.innerHTML = '<p class="note">Empty.</p>';
    return;
  }
  const [headRow, ...rest] = rows;
  const shown = rest.slice(0, 2000);
  const num = headRow.map((_, j) => shown.length > 0 && shown.every((r) => r[j] === undefined || r[j] === '' || !isNaN(Number(r[j]))));
  body.innerHTML = `<div class="code-foot"><input class="filter" id="tfilter" placeholder="Filter rows"><span class="faint">${rest.length.toLocaleString()} rows · ${headRow.length} columns${rest.length > shown.length ? ` · showing ${shown.length}` : ''}</span></div>
  <div class="tablewrap"><table class="grid-table"><thead><tr><th>#</th>${headRow.map((h, j) => `<th data-col="${j}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${shown
    .map((r, i) => `<tr><td class="faint">${i + 1}</td>${headRow.map((_, j) => `<td${num[j] ? ' class="num"' : ''}>${esc(r[j] ?? '')}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
  const tb = body.querySelector('tbody');
  $('tfilter').oninput = (ev) => {
    const q = ev.target.value.toLowerCase();
    for (const tr of tb.rows) tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q);
  };
  let sortCol = -1,
    asc = true;
  body.querySelectorAll('th[data-col]').forEach(
    (th) =>
      (th.onclick = () => {
        const j = Number(th.dataset.col);
        asc = sortCol === j ? !asc : true;
        sortCol = j;
        const trs = [...tb.rows];
        trs.sort((a, b) => {
          const x = a.cells[j + 1].textContent,
            y = b.cells[j + 1].textContent;
          const r = num[j] ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true });
          return asc ? r : -r;
        });
        tb.append(...trs);
        body.querySelectorAll('th').forEach((h) => (h.dataset.sort = ''));
        th.dataset.sort = asc ? '▲' : '▼';
      }),
  );
}

function jsonTree(v, depth) {
  if (v === null) return '<span class="tok-literal">null</span>';
  if (typeof v === 'string') return `<span class="tok-string">"${esc(v.length > 2000 ? v.slice(0, 2000) + '…' : v)}"</span>`;
  if (typeof v === 'number') return `<span class="tok-number">${v}</span>`;
  if (typeof v === 'boolean') return `<span class="tok-literal">${v}</span>`;
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return arr ? '[]' : '{}';
  const shown = entries.slice(0, 1000);
  const kids = shown
    .map(([k, x]) => `<div class="jrow">${arr ? `<span class="faint">${k}</span>` : `<span class="jkey">${esc(k)}</span>`}: ${jsonTree(x, depth + 1)}</div>`)
    .join('');
  const more = entries.length > shown.length ? `<div class="faint">… ${entries.length - shown.length} more</div>` : '';
  return `<details${depth < 2 ? ' open' : ''}><summary>${arr ? `[ ${entries.length} ]` : `{ ${entries.length} }`}</summary><div class="jkids">${kids}${more}</div></details>`;
}

function notebook(body, t, folder) {
  let nb;
  try {
    nb = JSON.parse(t);
  } catch (err) {
    body.innerHTML = `<p class="note">Not a valid notebook: ${esc(err.message)}</p>`;
    return;
  }
  const src = (s) => (Array.isArray(s) ? s.join('') : s || '');
  const lang = nb.metadata?.language_info?.file_extension || '.py';
  const cells = (nb.cells || []).map((c) => {
    if (c.cell_type === 'markdown') return `<div class="nb-md md" data-md="${esc(src(c.source))}"></div>`;
    const code = codeBlockHtml(src(c.source), langOf('x' + lang), `In [${c.execution_count ?? ' '}]`);
    const outs = (c.outputs || [])
      .map((o) => {
        const d = o.data || {};
        if (d['image/png']) return `<img class="nb-img" src="data:image/png;base64,${src(d['image/png']).replace(/\s/g, '')}" alt="">`;
        if (d['image/jpeg']) return `<img class="nb-img" src="data:image/jpeg;base64,${src(d['image/jpeg']).replace(/\s/g, '')}" alt="">`;
        const text = d['text/plain'] ? src(d['text/plain']) : o.text ? src(o.text) : o.ename ? `${o.ename}: ${o.evalue}` : '';
        return text ? `<pre class="nb-out${o.output_type === 'error' ? ' err' : ''}">${esc(text.replace(/\x1b\[[\d;]*m/g, ''))}</pre>` : '';
      })
      .join('');
    return `<div class="nb-cell"><span class="nb-n faint"></span><div>${code}${outs}</div></div>`;
  });
  body.innerHTML = `<div class="nb">${cells.join('') || '<p class="note">An empty notebook.</p>'}</div>`;
  for (const m of body.querySelectorAll('[data-md]')) renderMarkdown(m, m.dataset.md, folder);
}
