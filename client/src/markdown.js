// Markdown: GitHub-flavoured (marked) with footnotes, math ($…$, $$…$$ and ```math, drawn as MathML by Temml),
// mermaid diagrams, GitHub alerts (> [!NOTE]), heading anchors, front matter, and code fences in the code-block look
// highlighted by Shiki. Inline HTML is allowed but sanitised (DOMPurify): no scripts, no event handlers, no styles
// that reach the page. Relative links open in the viewer; relative images load from the folder.
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import DOMPurify from 'dompurify';
import { copy, esc, join, norm, rawUrl } from './util.js';
import { fileHref, href, state } from './state.js';
import { highlightLines, prepare } from './shiki.js';
import { drawInto } from './mermaid.js';
import { icon } from './icons.js';

/** A code block as harness draws one: a caption bar (language, wrap, copy) over the highlighted code. */
export function codeBlockHtml(code, lang, caption = lang || 'text') {
  const name = 'x.' + (lang || 'txt');
  const lines = highlightLines(code.replace(/\n$/, ''), name);
  return `<figure class="ui-code${state.settings.wrap ? ' wrapped' : ''}" data-lang="${esc(lang)}"><figcaption class="cbar"><span class="caption">${esc(caption)}</span><span class="ctools"><button class="icon-btn${state.settings.wrap ? ' on' : ''}" data-cb="wrap" title="Wrap long lines" aria-label="Wrap long lines">${icon('wrap', 16)}</button><button class="icon-btn" data-cb="copy" title="Copy code" aria-label="Copy code">${icon('copy', 16)}</button></span></figcaption><pre class="code" tabindex="0"><code>${lines.join('\n')}</code></pre><textarea hidden>${esc(code)}</textarea></figure>`;
}

const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^\$\$/m)?.index,
  tokenizer(src) {
    const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer: (t) => `<div class="md-math-wrap"><div class="md-math md-math-block" data-tex="${encodeURIComponent(t.text)}">${esc(t.text)}</div></div>\n`,
};
const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    const m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d$])/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
  },
  renderer: (t) => `<span class="md-math" data-tex="${encodeURIComponent(t.text)}">${esc(t.text)}</span>`,
};

const slugger = () => {
  const seen = new Map();
  return (text) => {
    const base =
      text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
};

function makeMarked() {
  let slug = slugger();
  const m = new Marked({ gfm: true });
  m.use(markedFootnote({ description: 'Footnotes' }));
  m.use({
    extensions: [mathBlock, mathInline],
    hooks: {
      preprocess(src) {
        slug = slugger();
        return src;
      },
    },
    renderer: {
      code({ text, lang }) {
        const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
        if (l === 'mermaid') return `<div class="md-diagram" data-diagram="${encodeURIComponent(text)}"></div>`;
        if (l === 'math' || l === 'latex' || l === 'tex') return mathBlock.renderer({ text });
        return codeBlockHtml(text, l);
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(inner);
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#" data-anchor="${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
    },
  });
  return m;
}
const marked = makeMarked();

/** "---\nkey: value\n---" at the top: shown as a small table, not as text */
function frontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) return { body: src, front: '' };
  const rows = m[1]
    .split(/\r?\n/)
    .map((l) => /^([\w.-]+):\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map(([, k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  return { body: src.slice(m[0].length), front: rows ? `<div class="md-table front"><table>${rows}</table></div>` : '' };
}

const ALERTS = { NOTE: ['note', 'info'], TIP: ['tip', 'sparkles'], IMPORTANT: ['important', 'warning'], WARNING: ['warning', 'warning'], CAUTION: ['caution', 'warning'] };

/** Render markdown into el; folder is where relative links and images are found. */
export function renderMarkdown(el, src, folder) {
  const { body, front } = frontMatter(src);
  const html = DOMPurify.sanitize(front + marked.parse(body), {
    ADD_ATTR: ['target', 'data-anchor', 'data-diagram', 'data-tex', 'data-lang', 'data-cb'],
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['style'],
  });
  el.innerHTML = html;
  enhance(el, folder);
}

function enhance(el, folder) {
  for (const t of el.querySelectorAll('table')) {
    if (t.parentElement?.classList.contains('md-table')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-table';
    t.replaceWith(wrap);
    wrap.append(t);
  }
  for (const a of el.querySelectorAll('a[href]')) {
    if (a.dataset.anchor) continue;
    const u = a.getAttribute('href') || '';
    if (/^(https?:|mailto:|tel:)/i.test(u)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (u.startsWith('#')) {
      // in-page anchors (footnotes, headings): the address's # is the viewer's, so scroll instead
      a.dataset.anchor = decodeURIComponent(u.slice(1));
      a.setAttribute('href', '#');
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      const [p, hash = ''] = u.split('#');
      const full = norm(p.startsWith('/') ? p : join(folder, decodeURIComponent(p)));
      const line = /^L(\d+)(?:-L?(\d+))?/.exec(hash);
      if (p.endsWith('/') || !p) a.setAttribute('href', href({ folder: full }));
      else a.setAttribute('href', fileHref(full, line ? { line: line[2] ? `${line[1]}-${line[2]}` : line[1] } : {}));
    } else a.removeAttribute('href');
  }
  for (const img of el.querySelectorAll('img[src]')) {
    const u = img.getAttribute('src') || '';
    if (!/^(https?:|data:image\/|blob:)/i.test(u)) img.src = rawUrl(norm(u.startsWith('/') ? u : join(folder, decodeURIComponent(u))));
    img.loading = 'lazy';
  }
  for (const q of el.querySelectorAll('blockquote')) {
    const first = q.querySelector('p');
    const m = first && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.innerHTML);
    if (!m) continue;
    const [cls, ic] = ALERTS[m[1].toUpperCase()];
    first.innerHTML = first.innerHTML.slice(m[0].length).replace(/^<br>\s*/, '');
    if (!first.textContent.trim() && !first.querySelector('img')) first.remove();
    q.classList.add('alert', cls);
    q.insertAdjacentHTML('afterbegin', `<div class="alert-title">${icon(ic, 16)}${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()}</div>`);
  }
  for (const d of el.querySelectorAll('[data-diagram]')) drawInto(d, decodeURIComponent(d.dataset.diagram));
  const maths = el.querySelectorAll('[data-tex]');
  if (maths.length)
    import('temml').then(({ default: temml }) => {
      for (const m of maths) {
        try {
          m.innerHTML = temml.renderToString(decodeURIComponent(m.dataset.tex), { displayMode: m.classList.contains('md-math-block'), throwOnError: false });
        } catch {
          // leave the TeX as text
        }
      }
    });
  upgradeCode(el);
}

/** Redraw code blocks with Shiki once each language's grammar is in. */
export function upgradeCode(el) {
  for (const fig of el.querySelectorAll('figure.ui-code[data-lang]')) {
    const lang = fig.dataset.lang;
    if (!lang) continue;
    prepare('x.' + lang).then((ok) => {
      if (!ok || !fig.isConnected) return;
      const src = fig.querySelector('textarea')?.value ?? '';
      fig.querySelector('code').innerHTML = highlightLines(src.replace(/\n$/, ''), 'x.' + lang).join('\n');
    });
  }
}

// the code block's buttons and in-page anchors, wherever they are drawn
document.addEventListener('click', (e) => {
  const cb = e.target.closest('[data-cb]');
  if (cb) {
    const fig = cb.closest('.ui-code');
    if (cb.dataset.cb === 'wrap') {
      fig.classList.toggle('wrapped');
      cb.classList.toggle('on', fig.classList.contains('wrapped'));
    } else if (cb.dataset.cb === 'copy') {
      const text = fig.querySelector('textarea')?.value ?? fig.querySelector('code')?.textContent ?? '';
      copy(text, 'Code copied').then(() => {
          cb.innerHTML = icon('check', 16);
          cb.classList.add('copied');
          setTimeout(() => {
            cb.innerHTML = icon('copy', 16);
            cb.classList.remove('copied');
          }, 1600);
      });
    }
    return;
  }
  const a = e.target.closest('a[data-anchor]');
  if (a) {
    e.preventDefault();
    const root = a.closest('.md') || document;
    const id = a.dataset.anchor;
    const target = root.querySelector('#' + CSS.escape(id)) || root.querySelector(`[id="user-content-${CSS.escape(id)}"]`) || document.getElementById(id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/** Markdown as an HTML string (for comments): the same rendering, without diagrams or math drawn later. */
export function markdownHtml(src, folder) {
  const div = document.createElement('div');
  renderMarkdown(div, src, folder);
  return div.innerHTML;
}
