// The Changes pages: what's uncommitted (every changed file and, if asked, all their diffs), the commit history
// (pushed, only here, or not pulled yet), and one commit with all of its diffs.
import { ago, api, esc, extOf, rawUrl } from './util.js';
import { IMG } from './file.js';

const isPic = (p) => IMG.has(extOf(p)) || extOf(p) === 'svg';
import { LABEL, commentsOn, fileHref, go, href, nav, state, where } from './state.js';
import { badge } from './folder.js';
import { placeDiffThreads, renderDiff } from './code.js';
import { composerHtml, fileThreadsHtml } from './review.js';
import { icon } from './icons.js';

const ORDER = ['conflict', 'modified', 'renamed', 'added', 'new', 'deleted'];

export function branchHtml() {
  const g = state.git;
  if (!g) return '';
  const sync = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  return `<span class="branch" title="${esc(g.upstream ? `Tracking ${g.upstream}` : 'No upstream')}">${icon('git-branch', 14)}${esc(g.branch || 'detached')}${g.head ? ` <span class="faint">${esc(g.head)}</span>` : ''}${sync ? ` <span class="sync">${sync}</span>` : ''}</span>`;
}

/** the page's tabs: what's uncommitted, and the history */
function tabsHtml(on) {
  const n = state.git?.changes.length || 0;
  return `<div class="tabs gtabs"><button class="btn${on === 'changes' ? ' on' : ''}" data-gt="changes">Uncommitted${n ? ` <span class="count-pill">${n}</span>` : ''}</button><button class="btn${on === 'history' ? ' on' : ''}" data-gt="history">${icon('clock', 14)} History</button></div>`;
}
function wireTabs(el) {
  el.querySelectorAll('[data-gt]').forEach((b) => (b.onclick = () => go({ folder: where().folder, m: b.dataset.gt })));
}

const noRepo = (el) => (el.innerHTML = '<p class="empty">This folder isn’t in a git repository, so there are no changes to show.</p>');

// ── uncommitted ──
export async function renderChanges(el) {
  const g = state.git;
  if (!g) return noRepo(el);
  const w = where();
  const all = w.q === 'all';
  const counts = {};
  for (const c of g.changes) counts[c.state] = (counts[c.state] || 0) + 1;
  const list = [...g.changes].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.path.localeCompare(b.path));
  const add = g.changes.reduce((n, c) => n + (c.add || 0), 0),
    del = g.changes.reduce((n, c) => n + (c.del || 0), 0);
  const legend = ORDER.filter((s) => counts[s])
    .map((s) => `<span class="legend">${badge(s)} ${counts[s]} ${LABEL[s].toLowerCase()}</span>`)
    .join('');
  el.innerHTML = `<header class="head"><h2 class="page-title">${icon('diff')} Changes</h2>${branchHtml()}</header>
  ${tabsHtml('changes')}
  ${
    list.length
      ? `<div class="head"><span class="meta"><span class="plus">+${add}</span> <span class="minus">−${del}</span> in ${list.length} files</span>${legend}<span class="grow"></span>
    <button class="btn${all ? '' : ' on'}" data-cv="">Files</button><button class="btn${all ? ' on' : ''}" data-cv="all">All diffs</button></div>
  <div class="rows">${list.map((c) => fileRow(c, fileHref(c.path, { tab: 'diff' }), c.staged)).join('')}</div>
  ${all ? '<div id="all-diffs"></div>' : ''}`
      : '<p class="empty">Nothing has changed since the last commit. ✨</p>'
  }`;
  wireTabs(el);
  el.querySelectorAll('[data-cv]').forEach((b) => (b.onclick = () => nav({ q: b.dataset.cv })));
  if (!list.length) return;
  if (!all) {
    // fetch the diffs now, so All diffs opens drawn (no "Loading…" flash)
    for (const c of list.slice(0, 40)) {
      const u = 'api/git/diff?p=' + encodeURIComponent(c.path);
      if (!isPic(c.path))
        api(u)
          .then((d) => diffCache.set(u, d))
          .catch(() => {});
    }
    return;
  }
  diffList(el.querySelector('#all-diffs'), list.slice(0, 80), {
    url: (c) => 'api/git/diff?p=' + encodeURIComponent(c.path),
    link: (c) => fileHref(c.path, { tab: 'diff' }),
    comments: !state.info.readOnly,
    key: 'now',
    picture: (c) =>
      isPic(c.path) && {
        before: c.state === 'new' || c.state === 'added' ? '' : `api/git/raw?p=${encodeURIComponent(c.from || c.path)}`,
        after: c.state === 'deleted' ? '' : rawUrl(c.path),
      },
  });
}

function fileRow(c, href, staged) {
  return `<a class="row s-${c.state}" href="${href}"><span class="ico">${icon(c.state === 'deleted' ? 'trash' : 'file', 18)}</span><span class="nm">${esc(c.path)}${c.from ? ` <span class="faint">← ${esc(c.from)}</span>` : ''}</span><span class="marks">${staged ? '<span class="pill" title="Staged">staged</span>' : ''}${badge(c.state)}</span><span class="sz">${c.add !== undefined ? `<span class="plus">+${c.add}</span> <span class="minus">−${c.del || 0}</span>` : ''}</span><span class="tm">${LABEL[c.state]}</span></a>`;
}

/**
 * A run of files' diffs, each collapsible, with Collapse all. Diffs already fetched draw at once from memory (no
 * "Loading…" flash when the page redraws); a fresh copy replaces one only when it differs.
 */
function diffList(host, files, { url, link, comments, key, picture }) {
  const foldKey = (c) => key + ':' + c.path;
  host.innerHTML = `<div class="diffs-bar"><span class="faint">${comments ? 'Tap a line number to comment on that line.' : ''}</span><span class="grow"></span><button class="btn small" data-fold="all"></button></div>`;
  for (const c of files) {
    const sec = document.createElement('section');
    const shut = folded.has(foldKey(c));
    sec.className = 'diff-file' + (shut ? ' folded' : '');
    sec.dataset.path = c.path;
    sec.dataset.fk = foldKey(c);
    sec.innerHTML = `<h3 class="group-title"><button class="mini fold" data-fold="one" aria-expanded="${!shut}" title="Collapse or expand" aria-label="Collapse or expand ${esc(c.path)}">${icon('chevron-down', 16)}</button><a href="${link(c)}">${esc(c.path)}</a>${badge(c.state)}${
      c.add !== undefined ? `<span class="sz faint"><span class="plus">+${c.add}</span> <span class="minus">−${c.del || 0}</span></span>` : ''
    }<span class="ncom"></span><span class="grow"></span>${
      comments ? `<button class="mini" data-fcom title="Comment on the whole file" aria-label="Comment on ${esc(c.path)}">${icon('chat', 14)}<span class="hide-sm"> Comment</span></button>` : ''
    }</h3><div class="fold-body"><div class="fthreads"></div><div class="dbody"></div></div>`;
    host.append(sec);
    if (comments) paintFileThreads(sec);
    const body = sec.querySelector('.dbody');
    const pic = picture?.(c);
    if (pic) {
      // a picture: before and after, side by side
      body.innerHTML = `<div class="compare">${pic.before ? `<figure><figcaption>Before</figcaption><div class="stage"><img src="${pic.before}" alt="Before" loading="lazy"></div></figure>` : ''}${pic.after ? `<figure><figcaption>${pic.before ? 'After' : 'Added'}</figcaption><div class="stage"><img src="${pic.after}" alt="After" loading="lazy"></div></figure>` : '<figure><figcaption>Deleted</figcaption></figure>'}</div>`;
      continue;
    }
    const u = url(c);
    const had = diffCache.get(u);
    const draw = (d) => renderDiff(body, d, c.path, { comments, caption: c.path });
    if (had !== undefined) draw(had);
    else body.innerHTML = '<p class="note">Loading…</p>';
    // a commit's diffs never change: no need to ask again
    if (had !== undefined && key !== 'now') continue;
    api(u)
      .then((d) => {
        diffCache.set(u, d);
        if (d !== had && body.isConnected) draw(d);
      })
      .catch((err) => {
        if (had === undefined) body.innerHTML = `<p class="note">${esc(err.message)}</p>`;
      });
  }
  const allBtn = host.querySelector('[data-fold="all"]');
  const paintAll = () => {
    const any = files.some((c) => !folded.has(foldKey(c)));
    allBtn.innerHTML = `${icon(any ? 'chevron-right' : 'chevron-down', 14)} ${any ? 'Collapse all' : 'Expand all'}`;
    allBtn.dataset.to = any ? 'collapse' : 'expand';
  };
  paintAll();
  host.onclick = (e) => {
    const b = e.target.closest('[data-fold], [data-fcom]');
    if (!b) return;
    if (b.dataset.fold === 'all') {
      const shut = b.dataset.to === 'collapse';
      for (const sec of host.querySelectorAll('.diff-file')) setFold(sec, shut);
    } else if (b.dataset.fold === 'one') {
      const sec = b.closest('.diff-file');
      setFold(sec, !sec.classList.contains('folded'));
    } else {
      const sec = b.closest('.diff-file');
      setFold(sec, false);
      const box = sec.querySelector('.fthreads');
      if (!box.querySelector('.composer')) box.insertAdjacentHTML('beforeend', composerHtml(sec.dataset.path, 0, 0));
      box.querySelector('.composer textarea').focus();
    }
    paintAll();
  };
}

/** diff text by URL, so a redraw shows the diffs at once */
const diffCache = new Map();

/** which files' diffs are collapsed (kept for the tab's life) */
const folded = new Set(JSON.parse(sessionGet('folded') || '[]'));
function sessionGet(k) {
  try {
    return sessionStorage.getItem('folderview:' + k);
  } catch {
    return null;
  }
}
function setFold(sec, shut) {
  sec.classList.toggle('folded', shut);
  sec.querySelector('[data-fold="one"]').setAttribute('aria-expanded', String(!shut));
  if (shut) folded.add(sec.dataset.fk);
  else folded.delete(sec.dataset.fk);
  try {
    sessionStorage.setItem('folderview:folded', JSON.stringify([...folded]));
  } catch {}
}

function paintFileThreads(sec) {
  const path = sec.dataset.path;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const box = sec.querySelector('.fthreads');
  const draft = box.querySelector('.composer');
  box.innerHTML = fileThreadsHtml(path, folder);
  if (draft) box.append(draft);
  const n = commentsOn(path).filter((c) => c.status === 'open').length;
  sec.querySelector('.ncom').innerHTML = n ? `<span class="pill warn" title="Open comments">${icon('chat', 12)} ${n}</span>` : '';
}

/** comments changed: redraw every file's threads on the All diffs page in place */
export function refreshChangesThreads(el) {
  for (const sec of el.querySelectorAll('#all-diffs .diff-file')) {
    if (!sec.querySelector('.fthreads')) continue;
    paintFileThreads(sec);
    placeDiffThreads(sec.querySelector('.diff'));
  }
}

// ── history ──
const STATE = {
  local: ['arrow-up', 'Not pushed', 'Only in this copy: not pushed yet'],
  pushed: ['check', 'Pushed', 'On a remote'],
  incoming: ['arrow-down', 'Not pulled', 'On the upstream, not pulled here yet'],
  unknown: ['', '', ''],
};

function commitRow(c) {
  const [ic, label, title] = STATE[c.state];
  return `<a class="commit s-${c.state}" href="${esc(hrefFor(c.hash))}"><code>${esc(c.hash)}</code><span class="subj">${esc(c.subject)}</span><span class="faint">${esc(c.author)} · ${ago(c.time)}</span>${
    label ? `<span class="push ${c.state}" title="${title}">${icon(ic, 12)}<span class="hide-sm"> ${label}</span></span>` : ''
  }</a>`;
}
const hrefFor = (hash) => href({ folder: where().folder, m: 'history', q: hash });

/** commits drawn so far (kept so More and a redraw don't start over) */
let hist = null;

export async function renderHistory(el) {
  if (!state.git) return noRepo(el);
  const q = where().q;
  if (q) return renderCommit(el, q);
  el.innerHTML = `<header class="head"><h2 class="page-title">${icon('diff')} Changes</h2>${branchHtml()}</header>${tabsHtml('history')}<div id="hist"><div class="skeleton" style="width:60%"></div></div>`;
  wireTabs(el);
  try {
    if (!hist || hist.head !== state.git.head) hist = { head: state.git.head, ...(await api('api/git/history')) };
  } catch (err) {
    el.querySelector('#hist').innerHTML = `<p class="note">${esc(err.message)}</p>`;
    return;
  }
  drawHistory(el);
}

function drawHistory(el) {
  const h = hist;
  const box = el.querySelector('#hist');
  if (!box) return;
  const nLocal = h.commits.filter((c) => c.state === 'local').length;
  const summary = !h.remotes
    ? 'No remote: nothing here has been pushed anywhere.'
    : [h.upstream ? `Tracking <code>${esc(h.upstream)}</code>.` : 'No upstream branch.', nLocal ? `${nLocal}${h.more && nLocal === h.commits.length ? '+' : ''} not pushed.` : 'Everything shown is pushed.', h.incoming.length ? `${h.incoming.length} not pulled yet.` : ''].filter(Boolean).join(' ');
  box.innerHTML = `<p class="meta hist-sum">${summary}</p>
  ${h.incoming.length ? `<h3 class="group-title">${icon('arrow-down', 14)} Not pulled yet</h3><div class="commits">${h.incoming.map(commitRow).join('')}</div><h3 class="group-title">This branch</h3>` : ''}
  ${h.commits.length ? `<div class="commits">${h.commits.map(commitRow).join('')}</div>` : '<p class="empty">No commits yet.</p>'}
  ${h.more ? '<button class="btn" id="hist-more">Show more</button>' : ''}`;
  const more = box.querySelector('#hist-more');
  if (more)
    more.onclick = async () => {
      more.disabled = true;
      const next = await api('api/git/history?skip=' + h.commits.length).catch(() => null);
      if (!next) return void (more.disabled = false);
      h.commits.push(...next.commits);
      h.more = next.more;
      drawHistory(el);
    };
}

// ── one commit ──
const commits = new Map();

async function renderCommit(el, hash) {
  el.innerHTML = `<header class="head"><h2 class="page-title">${icon('diff')} Changes</h2>${branchHtml()}</header>${tabsHtml('history')}<div id="commit"><div class="skeleton" style="width:60%"></div></div>`;
  wireTabs(el);
  let info = commits.get(hash);
  if (!info) {
    try {
      info = await api('api/git/commit-info?h=' + encodeURIComponent(hash));
      commits.set(hash, info);
    } catch (err) {
      el.querySelector('#commit').innerHTML = `<p class="note">${esc(err.message)}</p>`;
      return;
    }
  }
  if (where().q !== hash) return;
  const c = info.commit;
  const known = hist && [...hist.commits, ...hist.incoming].find((x) => x.full === c.full);
  const [ic, label, title] = known ? STATE[known.state] : STATE.unknown;
  const all = where().show !== 'files';
  const add = info.files.reduce((n, f) => n + (f.add || 0), 0),
    del = info.files.reduce((n, f) => n + (f.del || 0), 0);
  el.querySelector('#commit').innerHTML = `<div class="commit-card">
    <div class="commit-top"><a class="btn small" href="${esc(hrefFor(''))}">${icon('chevron-left', 14)} History</a><code class="hash" title="${esc(c.full)}">${esc(c.hash)}</code>${label ? `<span class="push ${known.state}" title="${title}">${icon(ic, 12)} ${label}</span>` : ''}</div>
    <h3 class="commit-subj">${esc(c.subject)}</h3>
    ${c.body ? `<pre class="commit-body">${esc(c.body)}</pre>` : ''}
    <p class="meta">${esc(c.author)} · ${new Date(c.time).toLocaleString()} (${ago(c.time)})${c.parents.length > 1 ? ` · merge of ${c.parents.map((p) => `<code>${esc(p.slice(0, 7))}</code>`).join(' + ')}, shown against the first` : ''}</p>
  </div>
  ${
    info.files.length
      ? `<div class="head"><span class="meta"><span class="plus">+${add}</span> <span class="minus">−${del}</span> in ${info.files.length} files</span><span class="grow"></span><button class="btn${all ? '' : ' on'}" data-cv="files">Files</button><button class="btn${all ? ' on' : ''}" data-cv="">All diffs</button></div>
  ${all ? '' : `<div class="rows">${info.files.map((f) => fileRow(f, esc(hrefFor(hash)), false)).join('')}</div>`}
  ${all ? '<div id="all-diffs"></div>' : ''}`
      : '<p class="empty">This commit changed nothing in this folder.</p>'
  }`;
  el.querySelectorAll('[data-cv]').forEach((b) => (b.onclick = () => nav({ show: b.dataset.cv })));
  // a file row opens All diffs at that file
  el.querySelectorAll('.rows .row').forEach((r, i) => {
    r.onclick = (e) => {
      e.preventDefault();
      nav({ show: '' });
      requestAnimationFrame(() => el.querySelectorAll('#all-diffs .diff-file')[i]?.scrollIntoView({ block: 'start' }));
    };
  });
  if (!all || !info.files.length) return;
  diffList(el.querySelector('#all-diffs'), info.files.slice(0, 120), {
    url: (f) => `api/git/commit-diff?h=${encodeURIComponent(c.full)}&p=${encodeURIComponent(f.path)}${f.from ? '&from=' + encodeURIComponent(f.from) : ''}`,
    link: (f) => fileHref(f.path, { tab: 'history' }),
    comments: false,
    key: c.full,
    picture: (f) =>
      isPic(f.path) && {
        before: f.state === 'added' || !c.parents[0] ? '' : `api/git/raw?p=${encodeURIComponent(f.from || f.path)}&rev=${c.parents[0]}`,
        after: f.state === 'deleted' ? '' : `api/git/raw?p=${encodeURIComponent(f.path)}&rev=${c.full}`,
      },
  });
}
