// The Changes page: the branch, every changed file (new, changed, deleted…) and, if asked, all their diffs.
import { api, esc } from './util.js';
import { LABEL, fileHref, nav, state, where } from './state.js';
import { badge } from './folder.js';
import { renderDiff } from './code.js';
import { icon } from './icons.js';

const ORDER = ['conflict', 'modified', 'renamed', 'added', 'new', 'deleted'];

export function branchHtml() {
  const g = state.git;
  if (!g) return '';
  const sync = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  return `<span class="branch" title="${esc(g.upstream ? `Tracking ${g.upstream}` : 'No upstream')}">${icon('git-branch', 14)}${esc(g.branch || 'detached')}${g.head ? ` <span class="faint">${esc(g.head)}</span>` : ''}${sync ? ` <span class="sync">${sync}</span>` : ''}</span>`;
}

export async function renderChanges(el) {
  const g = state.git;
  if (!g) {
    el.innerHTML = '<p class="empty">This folder isn’t in a git repository, so there are no changes to show.</p>';
    return;
  }
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
  ${
    list.length
      ? `<div class="head"><span class="meta"><span class="plus">+${add}</span> <span class="minus">−${del}</span> in ${list.length} files</span>${legend}<span class="grow"></span>
    <button class="btn${all ? '' : ' on'}" data-cv="">Files</button><button class="btn${all ? ' on' : ''}" data-cv="all">All diffs</button></div>
  <div class="rows">${list
    .map(
      (c) => `<a class="row s-${c.state}" href="${fileHref(c.path, { tab: 'diff' })}"><span class="ico">${icon(c.state === 'deleted' ? 'trash' : 'file', 18)}</span><span class="nm">${esc(c.path)}${c.from ? ` <span class="faint">← ${esc(c.from)}</span>` : ''}</span><span class="marks">${c.staged ? '<span class="pill" title="Staged">staged</span>' : ''}${badge(c.state)}</span><span class="sz">${c.add !== undefined ? `<span class="plus">+${c.add}</span> <span class="minus">−${c.del || 0}</span>` : ''}</span><span class="tm">${LABEL[c.state]}</span></a>`,
    )
    .join('')}</div>
  ${all ? '<div id="all-diffs"></div>' : ''}`
      : '<p class="empty">Nothing has changed since the last commit. ✨</p>'
  }`;
  el.querySelectorAll('[data-cv]').forEach((b) => (b.onclick = () => nav({ q: b.dataset.cv })));
  if (!all || !list.length) return;
  const host = el.querySelector('#all-diffs');
  for (const c of list.slice(0, 80)) {
    const sec = document.createElement('section');
    sec.className = 'diff-file';
    sec.innerHTML = `<h3 class="group-title"><a href="${fileHref(c.path, { tab: 'diff' })}">${esc(c.path)}</a>${badge(c.state)}</h3><div class="dbody"><p class="note">Loading…</p></div>`;
    host.append(sec);
    api('api/git/diff?p=' + encodeURIComponent(c.path))
      .then((d) => renderDiff(sec.querySelector('.dbody'), d, c.path))
      .catch((err) => (sec.querySelector('.dbody').innerHTML = `<p class="note">${esc(err.message)}</p>`));
  }
}
