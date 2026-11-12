// The folder tree on the left, with git colours on folders that have changes inside.
import { $, esc, join, store } from './util.js';
import { go, isIgnored, load, openCommentsUnder, state, where } from './state.js';
import { badge, clearFilter, stateOf } from './folder.js';
import { icon } from './icons.js';

const expanded = new Set(JSON.parse(store('open') || '[""]'));

function nodeHtml(p, label, cur) {
  const open = expanded.has(p);
  let kids = open && state.cache.has(p) ? state.cache.get(p).filter((e) => e.type === 'folder') : [];
  if (state.settings.ignored === 'hide') kids = kids.filter((k) => !isIgnored(join(p, k.name)));
  const st = p ? stateOf(p, 'folder') : '';
  const nc = p ? openCommentsUnder(p) : 0;
  return `<li><div class="item"><button class="twist" data-t="${esc(p)}" aria-expanded="${open}" aria-label="${open ? 'Close' : 'Open'} ${esc(label)}">${icon('chevron-right', 14)}</button><button class="node${cur === p ? ' chosen' : ''}${st ? ' s-' + st : ''}" data-c="${esc(p)}">${icon(open ? 'folder-open' : 'folder', 16)}<span class="nm">${esc(label)}</span>${nc ? `<span class="pill warn">${nc}</span>` : ''}${badge(st, true)}</button></div>${
    open ? `<ul class="level">${kids.map((k) => nodeHtml(join(p, k.name), k.name, cur)).join('')}</ul>` : ''
  }</li>`;
}

export async function renderTree() {
  const cur = where().folder;
  const parts = cur ? cur.split('/') : [];
  for (let i = 0; i <= parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  await Promise.all([...expanded].map((p) => load(p).catch(() => expanded.delete(p))));
  store('open', JSON.stringify([...expanded]));
  $('tree').innerHTML = nodeHtml('', state.info.name, cur);
  $('tree').querySelector('.chosen')?.scrollIntoView({ block: 'nearest' });
}

export function wireTree() {
  $('tree').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'),
      c = e.target.closest('[data-c]');
    if (t) {
      const p = t.dataset.t;
      expanded.has(p) ? expanded.delete(p) : expanded.add(p);
      renderTree();
    } else if (c) {
      clearFilter();
      go({ folder: c.dataset.c });
    }
  });
}
