// Puts the page together: layout, which view the address asks for, live updates, settings and shortcuts.
import { $, api, esc, on, emit, store, toast } from './util.js';
import { loadComments, loadGit, nav, go, setSetting, state, where } from './state.js';
import { renderTree, wireTree } from './tree.js';
import { renderFolder, wireFolder, clearFilter } from './folder.js';
import { closeFile, refreshFileThreads, renderFile } from './file.js';
import { focusSearch, forgetFiles, quickOpen, renderSearch, wireSearchBar } from './search.js';
import { branchHtml, renderChanges } from './changes.js';
import { renderReviewPage, updateReviewBadge } from './review.js';
import { icon } from './icons.js';

const phone = matchMedia('(max-width: 759px)');
/** what scrolls: the page on a phone, the pane on a wide screen */
const scroller = (el) => (phone.matches ? document.scrollingElement : el);
/** where a folder was scrolled to, so coming back from a file on a phone lands in the same place */
const folderScroll = new Map();
let lastOpen = '';

const wide = matchMedia('(min-width: 1000px)');
const roomy = matchMedia('(min-width: 1280px)');

function applyTheme() {
  const t = state.settings.theme;
  document.documentElement.dataset.theme = t === 'auto' ? '' : t;
}

function layout() {
  const { open } = where();
  const app = $('app');
  app.classList.toggle('rail', wide.matches);
  app.classList.toggle('split', !!open && roomy.matches);
  $('main').hidden = !!open && !roomy.matches;
  $('file').hidden = !open;
}

let mainKey = '';
async function renderMain(force = false) {
  const w = where();
  const key = JSON.stringify([w.folder, w.m, w.q, w.scope, w.opts, w.inc, w.view, w.open]);
  if (!force && key === mainKey) return;
  const scrolled = key === mainKey ? scroller($('main')).scrollTop : 0;
  mainKey = key;
  const m = $('main');
  if (busyTyping(m)) return; // don't wipe a reply being written; the next change redraws it
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === w.m));
  if (w.m === 'search' && w.q) await renderSearch(m);
  else if (w.m === 'changes') await renderChanges(m);
  else if (w.m === 'review') renderReviewPage(m, w.q);
  else await renderFolder(m);
  if (!(phone.matches && w.open)) scroller(m).scrollTop = scrolled;
}

const busyTyping = (el) => {
  const a = document.activeElement;
  return a && a.tagName === 'TEXTAREA' && el.contains(a) && a.value.trim();
};

function paintBar() {
  $('branch').innerHTML = branchHtml();
  const n = state.git ? state.git.changes.length : 0;
  $('changes-btn').hidden = !state.info.git;
  $('changes-count').textContent = String(n);
  $('changes-count').hidden = !n;
  updateReviewBadge();
}

async function render() {
  const w = where();
  // a phone: remember the folder's scroll when a file opens over it, and go back to it when the file closes
  if (phone.matches && w.open && !lastOpen) folderScroll.set(w.folder, document.scrollingElement.scrollTop);
  const closing = phone.matches && !w.open && lastOpen;
  lastOpen = w.open;
  layout();
  await renderMain(closing);
  if (w.open) renderFile($('file'));
  else closeFile();
  if (closing) document.scrollingElement.scrollTop = folderScroll.get(w.folder) || 0;
  if (wide.matches) renderTree();
  document.title = `${w.open || (w.m === 'search' ? '“' + w.q + '”' : w.folder.split('/').pop() || state.info.name)} — folderview`;
}

// ── live updates ──
function connect() {
  const es = new EventSource('api/events');
  es.addEventListener('hello', () => $('live').classList.add('on'));
  es.onerror = () => $('live').classList.remove('on');
  es.addEventListener('change', async (ev) => {
    const b = JSON.parse(ev.data);
    for (const f of b.folders) state.cache.delete(f);
    if (b.files.length) forgetFiles();
    if (b.git) await loadGit();
    paintBar();
    const w = where();
    const openPath = w.open ? (w.folder ? w.folder + '/' : '') + w.open : '';
    if (w.m === 'changes' ? b.git : !w.m && (b.folders.includes(w.folder) || b.git)) await renderMain(true);
    if (openPath && b.files.includes(openPath)) renderFile($('file'), true);
    if (wide.matches) renderTree();
  });
  es.addEventListener('comments', async () => {
    await loadComments();
    emit('comments');
  });
}

on('comments', () => {
  updateReviewBadge();
  refreshFileThreads($('file'));
  const w = where();
  if (w.m === 'review' || !w.m) renderMain(true);
  if (wide.matches) renderTree();
});
on('settings', () => {
  applyTheme();
  renderMain(true);
  if (where().open) renderFile($('file'), true);
  if (wide.matches) renderTree();
});

// ── settings ──
function settingsPanel() {
  const old = $('settings-pop');
  if (old) return old.remove();
  const s = state.settings;
  const pop = document.createElement('div');
  pop.id = 'settings-pop';
  pop.className = 'pop';
  pop.innerHTML = `<h3>Settings</h3>
  <label>Theme <select data-s="theme"><option value="auto">Match the system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
  <label>Ignored files <select data-s="ignored"><option value="dim">Show dimmed</option><option value="hide">Hide</option></select></label>
  <label class="check"><input type="checkbox" data-s="wrap"> Wrap long lines</label>
  <label class="check"><input type="checkbox" data-s="review"> Review mode (click a line to comment)</label>
  <label class="check"><input type="checkbox" data-s="resolved"> Show resolved comments in files</label>
  <label>Your name on comments <input data-s="author" placeholder="${esc(state.info.author)}" value="${esc(s.author)}"></label>
  <h3>Shortcuts</h3>
  <dl class="keys"><dt><kbd>Ctrl</kbd> <kbd>P</kbd></dt><dd>Go to a file</dd><dt><kbd>/</kbd></dt><dd>Search</dd><dt><kbd>Esc</kbd></dt><dd>Close the file</dd><dt><kbd>Shift</kbd>-click</dt><dd>Select a range of lines</dd><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Save a comment</dd></dl>
  <p class="faint">folderview ${esc(state.info.version || '')} · ${esc(state.info.root || '')}</p>`;
  document.body.append(pop);
  for (const el of pop.querySelectorAll('[data-s]')) {
    const k = el.dataset.s;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
    el.onchange = () => {
      setSetting(k, el.type === 'checkbox' ? el.checked : el.value.trim());
      emit('settings');
    };
  }
  setTimeout(() => {
    const away = (e) => {
      if (!pop.contains(e.target) && e.target !== $('settings-btn')) {
        pop.remove();
        removeEventListener('pointerdown', away);
      }
    };
    addEventListener('pointerdown', away);
  });
}

// ── shortcuts ──
addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'k')) {
    e.preventDefault();
    quickOpen();
  } else if (e.key === '/' && !typing) {
    e.preventDefault();
    focusSearch();
  } else if (e.key === 'Escape' && !typing && !$('qo') && where().open) {
    nav({ open: '', tab: '', line: '' });
  } else if (e.key === 'Escape' && document.activeElement === $('q')) $('q').blur();
});

// ── the splitter ──
function wireSplitter() {
  const tw = Number(store('tree')) || 280;
  $('app').style.setProperty('--tree', tw + 'px');
  $('splitter').onpointerdown = (e) => {
    e.preventDefault();
    const mv = (ev) => {
      const w = Math.min(560, Math.max(180, ev.clientX));
      $('app').style.setProperty('--tree', w + 'px');
      store('tree', String(w));
    };
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
}

async function boot() {
  applyTheme();
  try {
    state.info = await api('api/info');
  } catch (err) {
    $('main').innerHTML = `<p class="empty">Can't reach the filescope server: ${esc(err.message)}</p>`;
    return;
  }
  $('repo').textContent = state.info.name;
  $('search-icon').innerHTML = icon('search', 16);
  $('qo-btn').insertAdjacentHTML('afterbegin', icon('file'));
  $('changes-btn').insertAdjacentHTML('afterbegin', icon('diff'));
  $('review-btn').insertAdjacentHTML('afterbegin', icon('chat'));
  $('settings-btn').innerHTML = icon('settings');
  // the sticky file header sits under the bar on a phone
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px')).observe($('bar'));
  phone.onchange = () => render();
  $('home').onclick = () => {
    clearFilter();
    go({ folder: '' });
  };
  document.querySelectorAll('[data-nav]').forEach(
    (b) =>
      (b.onclick = () => {
        const w = where();
        if (w.m === b.dataset.nav) go({ folder: w.folder });
        else go({ folder: w.folder, m: b.dataset.nav });
      }),
  );
  $('qo-btn').onclick = () => quickOpen();
  $('settings-btn').onclick = settingsPanel;
  wireTree();
  wireFolder($('main'));
  wireSearchBar();
  wireSplitter();
  await Promise.all([loadGit(), loadComments()]);
  paintBar();
  addEventListener('hashchange', render);
  wide.onchange = () => render();
  roomy.onchange = () => render();
  await render();
  connect();
  if (state.info.readOnly) toast('Read-only: comments can’t be added');
}
boot();
