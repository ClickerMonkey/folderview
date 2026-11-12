// The code view (line numbers, git change marks, selection, inline comment threads) and the diff view.
import { esc, copy } from './util.js';
import { icon } from './icons.js';
import { highlightLines, langOf, prepare } from './shiki.js';
import { commentsOn, href, nav, setSetting, state, where } from './state.js';
import { composerHtml, threadHtml } from './review.js';

const MAX_LINES = 60000;

/** "12" or "12-14" → [12, 14] */
export function parseLines(s) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(s || '');
  if (!m) return null;
  const a = Number(m[1]),
    b = Number(m[2] || m[1]);
  return [Math.min(a, b), Math.max(a, b)];
}

// ── unified diffs ──
export function parseDiff(text) {
  const hunks = [];
  const head = [];
  let h = null,
    o = 0,
    n = 0;
  for (const l of text.replace(/\r/g, '').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (m) {
      h = { header: l, ctx: m[3].trim(), lines: [] };
      hunks.push(h);
      o = Number(m[1]);
      n = Number(m[2]);
      continue;
    }
    if (!h) {
      head.push(l);
      continue;
    }
    if (l.startsWith('+')) h.lines.push({ t: '+', text: l.slice(1), n: n++ });
    else if (l.startsWith('-')) h.lines.push({ t: '-', text: l.slice(1), o: o++ });
    else if (l.startsWith(' ')) h.lines.push({ t: ' ', text: l.slice(1), o: o++, n: n++ });
    else if (l.startsWith('\\')) h.lines.push({ t: '\\', text: l });
  }
  return { head, hunks };
}

/** which new-side lines were added or changed, and where lines were removed */
export function diffMarks(diff) {
  const marks = new Map();
  for (const h of diff.hunks) {
    let dels = 0;
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      if (l.t === '-') dels++;
      else if (l.t === '+') {
        marks.set(l.n, dels > 0 ? 'mod' : 'add');
        if (dels > 0) dels--;
      } else {
        if (dels > 0 && l.n) marks.set(l.n, marks.get(l.n) || 'del');
        dels = 0;
      }
    }
  }
  return marks;
}

// ── the code view ──
/** The code block's bar: what it is, and wrap / copy / download. */
export function codeBar(caption, { download } = {}) {
  return `<figcaption class="cbar"><span class="caption">${esc(caption)}</span><span class="ctools"><button class="icon-btn${state.settings.wrap ? ' on' : ''}" data-cv="wrap" title="Wrap long lines" aria-label="Wrap long lines">${icon('wrap', 16)}</button><button class="icon-btn" data-cv="copy" title="Copy" aria-label="Copy">${icon('copy', 16)}</button>${
    download ? `<a class="icon-btn" href="${download}" download title="Download" aria-label="Download">${icon('download', 16)}</a>` : ''
  }</span></figcaption>`;
}

export function renderCode(host, { path, text, folder, marks, caption, download }) {
  const body = text.length > 4_000_000 ? text.slice(0, 4_000_000) : text;
  const draw = () => {
    const html = highlightLines(body, path);
    if (html.length > 1 && html[html.length - 1] === '' && body.endsWith('\n')) html.pop();
    return html;
  };
  const html = draw();
  const shown = html.slice(0, MAX_LINES);
  const rows = shown.map((l, i) => {
    const n = i + 1;
    const mk = marks?.get(n);
    return `<div class="ln" data-n="${n}"><a class="gut" href="${href({ ...where(), line: String(n) })}" data-n="${n}">${n}</a><span class="mk${mk ? ' ' + mk : ''}"></span><span class="src">${l || ' '}</span></div>`;
  });
  const lang = langOf(path);
  const label = caption ?? `${lang || 'text'} · ${shown.length.toLocaleString()} ${shown.length === 1 ? 'line' : 'lines'}`;
  host.innerHTML = `<figure class="ui-code">${codeBar(label, { download })}<div class="code${state.settings.wrap ? ' wrap' : ''}${state.settings.review ? ' review' : ''}" tabindex="0" data-path="${esc(path)}" data-folder="${esc(folder)}">${rows.join('')}</div></figure>${
    html.length > MAX_LINES ? `<p class="note">Showing the first ${MAX_LINES.toLocaleString()} of ${html.length.toLocaleString()} lines.</p>` : ''
  }`;
  const code = host.querySelector('.code');
  code.lines = shown.length;
  code.text = text;
  wireSelection(code, path);
  placeThreads(code);
  const sel = parseLines(where().line);
  if (sel) select(code, sel[0], sel[1], true);
  // Shiki's colours, once the grammar is in: redraw each line's text in place (selection and threads stay)
  prepare(path).then((ok) => {
    if (!ok || !code.isConnected) return;
    const better = draw();
    const srcs = code.querySelectorAll('.ln > .src');
    srcs.forEach((s, i) => {
      if (better[i] !== undefined) s.innerHTML = better[i] || ' ';
    });
  });
  return code;
}

// the code block bar's buttons (code view and diff)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cv]');
  if (!b) return;
  const fig = b.closest('.ui-code');
  const code = fig?.querySelector('.code');
  if (!code) return;
  if (b.dataset.cv === 'wrap') {
    setSetting('wrap', !state.settings.wrap);
    document.querySelectorAll('.ui-code > .code').forEach((c) => c.classList.toggle('wrap', state.settings.wrap));
    document.querySelectorAll('[data-cv="wrap"]').forEach((x) => x.classList.toggle('on', state.settings.wrap));
  } else if (b.dataset.cv === 'copy') {
    const text = code.text ?? [...code.querySelectorAll('.src, .dsrc')].map((s) => s.textContent).join('\n');
    copy(text, 'Copied').then(() => {
      b.innerHTML = icon('check', 16);
      b.classList.add('copied');
      setTimeout(() => {
        b.innerHTML = icon('copy', 16);
        b.classList.remove('copied');
      }, 1600);
    });
  }
});

/** draw (again) the comment threads under their lines */
export function placeThreads(code) {
  if (!code) return;
  const path = code.dataset.path;
  const folder = code.dataset.folder;
  code.querySelectorAll(':scope > .threads').forEach((t) => t.remove());
  code.querySelectorAll('.ln.has-c').forEach((l) => l.classList.remove('has-c', 'has-open'));
  const list = commentsOn(path).filter((c) => c.line && (state.settings.resolved || c.status === 'open'));
  const byEnd = new Map();
  for (const c of list) {
    const at = Math.min(c.endLine || c.line, code.lines || 1);
    if (!byEnd.has(at)) byEnd.set(at, []);
    byEnd.get(at).push(c);
    for (let n = c.line; n <= (c.endLine || c.line); n++) {
      const ln = code.querySelector(`.ln[data-n="${n}"]`);
      ln?.classList.add('has-c');
      if (c.status === 'open') ln?.classList.add('has-open');
    }
  }
  for (const [at, cs] of byEnd) {
    const ln = code.querySelector(`.ln[data-n="${at}"]`);
    if (!ln) continue;
    const div = document.createElement('div');
    div.className = 'threads';
    div.innerHTML = cs.map((c) => `<div class="thread"><div class="thread-where">${c.endLine ? `Lines ${c.line}–${c.endLine}` : `Line ${c.line}`}${c.line > code.lines ? ' (past the end of the file now)' : ''}</div>${threadHtml(c, folder)}</div>`).join('');
    ln.after(div);
  }
}

function select(code, a, b, scroll) {
  code.sel = [a, b];
  code.querySelectorAll('.ln.sel').forEach((l) => l.classList.remove('sel'));
  for (let n = a; n <= b; n++) code.querySelector(`.ln[data-n="${n}"]`)?.classList.add('sel');
  code.querySelector(':scope > .selbar')?.remove();
  const last = code.querySelector(`.ln[data-n="${b}"]`);
  if (!last) return;
  const bar = document.createElement('div');
  bar.className = 'selbar';
  const label = a === b ? `Line ${a}` : `Lines ${a}–${b}`;
  bar.innerHTML = `<span class="faint">${label}</span>${state.info.readOnly ? '' : `<button class="btn small primary" data-sb="comment">${icon('chat', 14)} Comment</button>`}<button class="btn small" data-sb="link">${icon('link', 14)} Link</button><button class="btn small" data-sb="ref">path:line</button><button class="btn small" data-sb="text">${icon('copy', 14)} Lines</button><button class="mini" data-sb="clear" title="Clear the selection" aria-label="Clear the selection">${icon('x', 14)}</button>`;
  last.after(bar);
  if (scroll) requestAnimationFrame(() => code.querySelector(`.ln[data-n="${a}"]`)?.scrollIntoView({ block: 'center' }));
}

function clearSelection(code) {
  code.sel = null;
  code.querySelectorAll('.ln.sel').forEach((l) => l.classList.remove('sel'));
  code.querySelector(':scope > .selbar')?.remove();
  nav({ line: '' }, true);
}

export function openComposer(code, path, a, b) {
  code.querySelectorAll(':scope > .composer').forEach((c) => c.remove());
  const last = code.querySelector(`.ln[data-n="${b}"]`);
  if (!last) return;
  const anchor = last.nextElementSibling?.classList.contains('threads') ? last.nextElementSibling : last;
  anchor.insertAdjacentHTML('afterend', composerHtml(path, a, b));
  code.querySelector(':scope > .selbar')?.remove();
  const ta = code.querySelector('.composer textarea');
  ta.focus();
  ta.scrollIntoView({ block: 'nearest' });
}

function wireSelection(code, path) {
  code.addEventListener('click', (e) => {
    const g = e.target.closest('.gut');
    const sb = e.target.closest('[data-sb]');
    if (g) {
      e.preventDefault();
      const n = Number(g.dataset.n);
      const [a, b] = e.shiftKey && code.sel ? [Math.min(code.sel[0], n), Math.max(code.sel[1], n)] : [n, n];
      if (!e.shiftKey && code.sel && code.sel[0] === n && code.sel[1] === n) return clearSelection(code);
      select(code, a, b, false);
      nav({ line: a === b ? String(a) : `${a}-${b}` }, true);
      if (state.settings.review && !state.info.readOnly && !e.shiftKey) openComposer(code, path, a, b);
      return;
    }
    if (sb && code.sel) {
      const [a, b] = code.sel;
      const act = sb.dataset.sb;
      if (act === 'comment') openComposer(code, path, a, b);
      else if (act === 'link') copy(location.href, 'Link copied');
      else if (act === 'ref') copy(`${path}:${a}${a !== b ? '-' + b : ''}`, 'Copied');
      else if (act === 'text') {
        const t = [];
        for (let n = a; n <= b; n++) t.push(code.querySelector(`.ln[data-n="${n}"] .src`)?.textContent ?? '');
        copy(t.join('\n'), 'Lines copied');
      } else if (act === 'clear') clearSelection(code);
      return;
    }
    // review mode: a click on a line (not a text selection) comments on it
    const ln = e.target.closest('.ln');
    if (ln && state.settings.review && !state.info.readOnly && !String(getSelection()).trim()) {
      const n = Number(ln.dataset.n);
      const [a, b] = e.shiftKey && code.sel ? [Math.min(code.sel[0], n), Math.max(code.sel[1], n)] : [n, n];
      select(code, a, b, false);
      nav({ line: a === b ? String(a) : `${a}-${b}` }, true);
      openComposer(code, path, a, b);
    }
  });
}

// ── the diff view ──
export function renderDiff(host, text, path, { comments = true, caption = '' } = {}) {
  if (!text.trim()) {
    host.innerHTML = '<p class="note">No changes against the last commit.</p>';
    return;
  }
  const d = parseDiff(text);
  const meta = d.head.filter((l) => l && !/^(diff --git|index |--- |\+\+\+ |(new|deleted) file mode|similarity index|rename (from|to) )/.test(l));
  // each hunk's old and new sides are highlighted as whole runs of code, so comments and strings that span lines
  // colour right; Shiki redraws them once its grammar is in
  const lines = d.hunks.flatMap((h) => h.lines.filter((l) => l.t !== '\\'));
  const paint = () => {
    const out = new Map();
    for (const h of d.hunks) {
      for (const side of ['o', 'n']) {
        const ls = h.lines.filter((l) => l.t !== '\\' && (side === 'o' ? l.t !== '+' : l.t !== '-'));
        const html = highlightLines(ls.map((l) => l.text).join('\n'), path);
        ls.forEach((l, i) => {
          if (side === 'n' || l.t === '-') out.set(l, html[i] || ' ');
        });
      }
    }
    return out;
  };
  const painted = paint();
  const rows = [];
  for (const h of d.hunks) {
    rows.push(`<div class="dh"><span>${esc(h.header.replace(/@@(.*)$/, '@@'))}</span>${h.ctx ? `<span class="faint">${esc(h.ctx)}</span>` : ''}</div>`);
    for (const l of h.lines) {
      if (l.t === '\\') {
        rows.push(`<div class="dl meta"><span class="on"></span><span class="nn"></span><span class="dsrc faint">${esc(l.text)}</span></div>`);
        continue;
      }
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
      rows.push(
        `<div class="dl ${cls}"${l.n ? ` data-n="${l.n}"` : ''}><span class="on">${l.o ?? ''}</span><span class="nn">${l.n ? `<a class="gut" data-n="${l.n}">${l.n}</a>` : ''}</span><span class="dsrc"><i>${l.t === ' ' ? ' ' : l.t}</i><span class="dt">${painted.get(l)}</span></span></div>`,
      );
    }
  }
  const binary = !d.hunks.length && /Binary files/.test(text);
  const add = lines.filter((l) => l.t === '+').length;
  const del = lines.filter((l) => l.t === '-').length;
  host.innerHTML = `${meta.length ? `<pre class="commit-head">${esc(meta.join('\n'))}</pre>` : ''}${
    binary
      ? '<p class="note">A binary file changed; no line diff.</p>'
      : !d.hunks.length
        ? '<p class="note">No lines changed (only its name or mode).</p>'
      : `<figure class="ui-code">${codeBar(`${caption || path} · +${add} −${del}`)}<div class="diff code${state.settings.wrap ? ' wrap' : ''}${state.settings.review && comments ? ' review' : ''}" tabindex="0" data-path="${esc(path)}">${rows.join('')}</div></figure>`
  }`;
  const diff = host.querySelector('.diff');
  if (diff) {
    diff.text = text;
    prepare(path).then((ok) => {
      if (!ok || !diff.isConnected) return;
      const again = paint();
      diff.querySelectorAll('.dt').forEach((el, i) => {
        const v = again.get(lines[i]);
        if (v !== undefined) el.innerHTML = v;
      });
    });
  }
  if (!diff || !comments) return;
  placeDiffThreads(diff);
  diff.addEventListener('click', (e) => {
    if (state.info.readOnly || e.target.closest('.threads, .composer')) return;
    // a line number, or (in review mode) anywhere on a line that isn't a text selection
    const g = e.target.closest('.gut') || (state.settings.review && !String(getSelection()).trim() ? e.target.closest('.dl[data-n]') : null);
    if (!g) return;
    const n = Number(g.dataset.n);
    diff.querySelectorAll(':scope > .composer').forEach((c) => c.remove());
    const row = diff.querySelector(`.dl[data-n="${n}"]`);
    const anchor = row.nextElementSibling?.classList.contains('threads') ? row.nextElementSibling : row;
    anchor.insertAdjacentHTML('afterend', composerHtml(path, n, n));
    diff.querySelector('.composer textarea').focus();
  });
}

export function placeDiffThreads(diff) {
  if (!diff) return;
  diff.querySelectorAll(':scope > .threads').forEach((t) => t.remove());
  const path = diff.dataset.path;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  for (const c of commentsOn(path).filter((c) => c.line && (state.settings.resolved || c.status === 'open'))) {
    const row = diff.querySelector(`.dl[data-n="${c.endLine || c.line}"]`);
    if (!row) continue;
    let box = row.nextElementSibling?.classList.contains('threads') ? row.nextElementSibling : null;
    if (!box) {
      box = document.createElement('div');
      box.className = 'threads';
      row.after(box);
    }
    box.insertAdjacentHTML('beforeend', `<div class="thread"><div class="thread-where">${c.endLine ? `Lines ${c.line}–${c.endLine}` : `Line ${c.line}`}</div>${threadHtml(c, folder)}</div>`);
  }
}
