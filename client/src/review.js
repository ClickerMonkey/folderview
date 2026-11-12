// Review comments: the threads shown beside lines, the composer, and the Review page that lists them all.
import { $, api, ago, copy, emit, esc, toast } from './util.js';
import { author, commentsOn, fileHref, loadComments, nav, setSetting, state } from './state.js';
import { markdownHtml as markdown } from './markdown.js';
import { icon } from './icons.js';

export const range = (c) => (c.line ? (c.endLine ? `L${c.line}–${c.endLine}` : `L${c.line}`) : 'File');

async function changed() {
  await loadComments();
  emit('comments');
}

// ── a thread ──
export function threadHtml(c, folder) {
  const replies = (c.replies || [])
    .map((r) => `<div class="reply"><div class="cmt-head"><b>${esc(r.author)}</b><span class="faint">${ago(Date.parse(r.at))}</span></div><div class="cmt-body md">${markdown(r.body, folder)}</div></div>`)
    .join('');
  const done = c.status === 'resolved';
  const ro = state.info.readOnly;
  return `<div class="cmt${done ? ' resolved' : ''}" data-cid="${esc(c.id)}">
  <div class="cmt-head"><b>${esc(c.author || 'reviewer')}</b><span class="faint">${ago(Date.parse(c.createdAt))}</span>${done ? '<span class="pill ok">Resolved</span>' : ''}
  ${ro ? '' : `<span class="cmt-acts"><button class="mini" data-cact="${done ? 'reopen' : 'resolve'}" title="${done ? 'Reopen' : 'Resolve'}">${done ? icon('undo', 14) + ' Reopen' : icon('check', 14) + ' Resolve'}</button><button class="mini" data-cact="edit" title="Edit" aria-label="Edit">${icon('edit', 14)}</button><button class="mini" data-cact="delete" title="Delete" aria-label="Delete">${icon('trash', 14)}</button></span>`}</div>
  <div class="cmt-body md">${markdown(c.body, folder)}</div>
  ${replies}
  ${ro ? '' : `<form class="reply-form" data-cid="${esc(c.id)}"><textarea rows="1" placeholder="Reply…"></textarea><button class="btn small" type="submit">Reply</button></form>`}
</div>`;
}

export function composerHtml(path, line, endLine) {
  const where = line ? (endLine && endLine !== line ? `lines ${line}–${endLine}` : `line ${line}`) : 'this file';
  return `<form class="composer" data-path="${esc(path)}" data-line="${line || ''}" data-end="${endLine || ''}">
  <div class="composer-head">Comment on ${where} <span class="faint">as ${esc(author())}</span></div>
  <textarea rows="3" placeholder="What should change? Markdown works. Ctrl+Enter to save."></textarea>
  <div class="composer-acts"><button class="btn primary" type="submit">Comment</button><button class="btn" type="button" data-cancel>Cancel</button></div>
</form>`;
}

/** file-level threads (no line) for the file header area */
export function fileThreadsHtml(path, folder) {
  const list = commentsOn(path).filter((c) => !c.line && (state.settings.resolved || c.status === 'open'));
  return list.map((c) => `<div class="thread">${threadHtml(c, folder)}</div>`).join('');
}

// ── actions (delegated, so threads work wherever they are drawn) ──
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cact]');
  if (!b) return;
  const card = b.closest('[data-cid]');
  const id = card?.dataset.cid;
  if (!id) return;
  const act = b.dataset.cact;
  try {
    if (act === 'resolve' || act === 'reopen') await api('api/comments/' + id, { method: 'PATCH', json: { status: act === 'resolve' ? 'resolved' : 'open' } });
    else if (act === 'delete') {
      if (!confirm('Delete this comment?')) return;
      await api('api/comments/' + id, { method: 'DELETE' });
    } else if (act === 'edit') {
      const c = state.comments.find((x) => x.id === id);
      const body = card.querySelector(':scope > .cmt-body');
      body.outerHTML = `<form class="edit-form" data-cid="${esc(id)}"><textarea rows="3">${esc(c?.body || '')}</textarea><div class="composer-acts"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-cancel-edit>Cancel</button></div></form>`;
      card.querySelector('.edit-form textarea').focus();
      return;
    }
    await changed();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-cancel-edit]')) changed();
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    cancel.closest('.composer')?.remove();
    emit('composer-closed');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('form textarea')) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
  if (e.key === 'Escape' && e.target.matches('.composer textarea')) {
    e.stopPropagation();
    e.target.closest('.composer').remove();
    emit('composer-closed');
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('.composer, .reply-form, .edit-form')) return;
  e.preventDefault();
  const text = f.querySelector('textarea').value.trim();
  if (!text) return;
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    if (f.matches('.composer')) {
      const json = { path: f.dataset.path, body: text, author: author() };
      if (f.dataset.line) json.line = Number(f.dataset.line);
      if (f.dataset.end) json.endLine = Number(f.dataset.end);
      await api('api/comments', { method: 'POST', json });
      f.remove();
      emit('composer-closed');
    } else if (f.matches('.reply-form')) {
      await api(`api/comments/${f.dataset.cid}/replies`, { method: 'POST', json: { body: text, author: author() } });
    } else {
      await api('api/comments/' + f.dataset.cid, { method: 'PATCH', json: { body: text } });
    }
    await changed();
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
});

// grow reply boxes as they fill
document.addEventListener('input', (e) => {
  if (e.target.matches('.reply-form textarea, .composer textarea, .edit-form textarea')) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight + 2, 320) + 'px';
  }
});

// ── the Review page ──
const PROMPT = (md, json) =>
  `Read ${md}. It lists review comments on files in this folder (path:line, the quoted code, and the comment). ` +
  `Work through each open comment: make the change it asks for, then set that comment's "status" to "resolved" in ${json} ` +
  `and add a reply saying what you did. If you can't or shouldn't act on one, leave it open and reply with why.`;

export function renderReviewPage(el, filter) {
  const all = state.comments;
  const open = all.filter((c) => c.status === 'open');
  const shown = filter === 'resolved' ? all.filter((c) => c.status === 'resolved') : filter === 'all' ? all : open;
  const byFile = new Map();
  for (const c of [...shown].sort((a, b) => a.path.localeCompare(b.path) || (a.line || 0) - (b.line || 0))) {
    if (!byFile.has(c.path)) byFile.set(c.path, []);
    byFile.get(c.path).push(c);
  }
  const { md, json } = state.info.review;
  const mdLink = md && !md.startsWith('..') ? fileHref(md) : '';
  const tabs = [
    ['open', `Open (${open.length})`],
    ['resolved', `Resolved (${all.length - open.length})`],
    ['all', `All (${all.length})`],
  ]
    .map(([k, label]) => `<button class="btn${(filter || 'open') === k ? ' on' : ''}" data-rf="${k}">${label}</button>`)
    .join('');
  const groups = [...byFile]
    .map(
      ([path, cs]) => `<section class="rgroup"><h3 class="group-title"><a href="${fileHref(path)}">${esc(path || '.')}</a><span class="faint">${cs.length}</span></h3>${cs
        .map(
          (c) => `<div class="rcard"><div class="rwhere"><a class="pill" href="${fileHref(path, c.line ? { line: String(c.line) } : {})}">${range(c)}</a>${c.commit ? `<span class="faint">@ ${esc(c.commit)}</span>` : ''}</div>${
            c.quote ? `<pre class="quote">${esc(c.quote)}</pre>` : ''
          }${threadHtml(c, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}</div>`,
        )
        .join('')}</section>`,
    )
    .join('');
  el.innerHTML = `<header class="head"><h2 class="page-title">${icon('chat')} Review</h2>
  <label class="switch" title="Click any line of a file to comment on it"><input type="checkbox" id="rmode" ${state.settings.review ? 'checked' : ''}> Review mode</label></header>
  <p class="lede">Leave comments on files or lines (tap a line number). They're saved in <code>${esc(state.info.review.dir)}/</code> as <code>comments.json</code>, and written out as <code>REVIEW.md</code> for an agent to work through. Its replies and resolutions show up here live.</p>
  <div class="head"><div class="tabs">${tabs}</div><span class="grow"></span>
    ${mdLink ? `<a class="btn" href="${mdLink}">${icon('file', 16)} REVIEW.md</a>` : ''}
    <button class="btn" id="copy-prompt" title="Copy instructions to paste into your agent">${icon('copy', 16)} Copy prompt for an agent</button>
    ${all.length - open.length && !state.info.readOnly ? '<button class="btn" id="clear-resolved">Clear resolved</button>' : ''}</div>
  ${groups || `<p class="empty">${filter === 'resolved' ? 'Nothing resolved yet.' : filter === 'all' ? 'No comments yet. Open a file and click a line number to leave one.' : 'No open comments. Open a file and click a line number to leave one.'}</p>`}`;
  el.querySelectorAll('[data-rf]').forEach((b) => (b.onclick = () => nav({ q: b.dataset.rf === 'open' ? '' : b.dataset.rf })));
  el.querySelector('#rmode').onchange = (e) => {
    setSetting('review', e.target.checked);
    emit('settings');
  };
  el.querySelector('#copy-prompt').onclick = () => copy(PROMPT(md, json), 'Prompt copied');
  const clear = el.querySelector('#clear-resolved');
  if (clear)
    clear.onclick = async () => {
      if (!confirm('Remove every resolved comment?')) return;
      await api('api/comments?resolved=1', { method: 'DELETE' });
      await changed();
    };
}

export function updateReviewBadge() {
  const n = state.comments.filter((c) => c.status === 'open').length;
  const b = $('review-count');
  if (b) {
    b.textContent = String(n);
    b.hidden = !n;
  }
}
