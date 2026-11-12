// Live reload: watches the folder and tells open pages which folders changed (and when git's state may have).
import fs from 'node:fs';
import path from 'node:path';
import { NOISE } from './files.js';

export interface ChangeBatch {
  /** root-relative folders whose contents changed ('' is the root) */
  folders: string[];
  /** root-relative files that changed */
  files: string[];
  /** something in .git changed: a commit, stage, checkout */
  git: boolean;
}

export function watchTree(root: string, gitDir: string | undefined, onBatch: (b: ChangeBatch) => void): () => void {
  let folders = new Set<string>(),
    files = new Set<string>(),
    git = false;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const b: ChangeBatch = { folders: [...folders], files: [...files], git };
    folders = new Set();
    files = new Set();
    git = false;
    onBatch(b);
  };
  const bump = () => {
    timer ??= setTimeout(flush, 250);
  };
  const closers: (() => void)[] = [];

  try {
    const w = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) return bump();
      const rel = String(name).split(path.sep).join('/');
      const parts = rel.split('/');
      if (parts[0] === '.git') {
        // the index, HEAD and refs say git's view moved; objects and logs are noise
        if (/^\.git\/(index|HEAD|refs\/|packed-refs|MERGE_HEAD)/.test(rel)) {
          git = true;
          bump();
        }
        return;
      }
      if (parts.some((p) => NOISE.has(p))) return;
      files.add(rel);
      folders.add(parts.slice(0, -1).join('/'));
      git = true; // a working-tree edit changes git status too
      bump();
    });
    w.on('error', () => undefined);
    closers.push(() => w.close());
  } catch {
    // recursive watching isn't available here: no live reload, the page still works on refresh
  }

  // a served subfolder of a repo: .git is elsewhere, watch it on its own
  if (gitDir && !gitDir.startsWith(root + path.sep)) {
    try {
      const w = fs.watch(gitDir, (_e, name) => {
        if (name && /^(index|HEAD|packed-refs)$/.test(String(name))) {
          git = true;
          bump();
        }
      });
      w.on('error', () => undefined);
      closers.push(() => w.close());
    } catch {
      // fine without it
    }
  }
  return () => {
    for (const c of closers) c();
    if (timer) clearTimeout(timer);
  };
}
