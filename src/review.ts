// Review comments: on a file or on lines of it, kept in <review dir>/comments.json, with REVIEW.md beside it written
// for an LLM (or a person) to work through. Edits made to comments.json by hand or by an agent are picked up live.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type CommentStatus = 'open' | 'resolved';

export interface Reply {
  id: string;
  author: string;
  body: string;
  at: string;
}

export interface Comment {
  id: string;
  /** root-relative file (or folder) the comment is on */
  path: string;
  /** 1-based first line; absent for a comment on the whole file */
  line?: number;
  endLine?: number;
  /** the commented lines as they were when the comment was left */
  quote?: string;
  body: string;
  author: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt?: string;
  /** the commit the file was at (short hash), when in git */
  commit?: string;
  replies?: Reply[];
}

interface Store {
  version: 1;
  comments: Comment[];
}

const QUOTE_LINES = 12;

export class Review {
  readonly jsonPath: string;
  readonly mdPath: string;
  private comments: Comment[] = [];
  private lastWritten = '';
  private listeners = new Set<() => void>();
  private watcher: fs.FSWatcher | undefined;

  constructor(
    readonly dir: string,
    private readonly root: string,
  ) {
    this.jsonPath = path.join(dir, 'comments.json');
    this.mdPath = path.join(dir, 'REVIEW.md');
    this.load();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** watch comments.json for edits from outside (an agent resolving a comment) */
  watch(): void {
    if (this.watcher) return;
    const start = () => {
      try {
        this.watcher = fs.watch(this.dir, (_e, name) => {
          if (name && String(name) !== 'comments.json') return;
          setTimeout(() => this.reloadIfChanged(), 60);
        });
      } catch {
        this.watcher = undefined;
      }
    };
    if (fs.existsSync(this.dir)) start();
    else {
      // the folder appears with the first comment; poll until then
      const t = setInterval(() => {
        if (fs.existsSync(this.dir)) {
          clearInterval(t);
          start();
          this.reloadIfChanged();
        }
      }, 2000);
      t.unref();
    }
  }

  close(): void {
    this.watcher?.close();
  }

  private reloadIfChanged(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.jsonPath, 'utf8');
    } catch {
      text = '';
    }
    if (text === this.lastWritten) return;
    this.load();
    this.writeMarkdown(); // keep REVIEW.md in step with the hand edit
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private load(): void {
    try {
      const text = fs.readFileSync(this.jsonPath, 'utf8');
      this.lastWritten = text;
      const data: unknown = JSON.parse(text);
      const list = data && typeof data === 'object' && 'comments' in data && Array.isArray(data.comments) ? data.comments : [];
      this.comments = list.filter(isComment);
    } catch {
      // no file yet, or a half-written hand edit: keep what we had
    }
  }

  all(): Comment[] {
    return this.comments;
  }

  add(input: { path: string; line?: number; endLine?: number; body: string; author: string; commit?: string }): Comment {
    const c: Comment = {
      id: crypto.randomBytes(4).toString('hex'),
      path: input.path,
      body: input.body.trim(),
      author: input.author || 'reviewer',
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    if (input.line) {
      c.line = input.line;
      if (input.endLine && input.endLine > input.line) c.endLine = input.endLine;
      const quote = this.quote(input.path, input.line, c.endLine ?? input.line);
      if (quote !== undefined) c.quote = quote;
    }
    if (input.commit) c.commit = input.commit;
    this.comments.push(c);
    this.save();
    return c;
  }

  update(id: string, patch: { body?: string; status?: CommentStatus }): Comment | undefined {
    const c = this.comments.find((x) => x.id === id);
    if (!c) return undefined;
    if (typeof patch.body === 'string' && patch.body.trim()) c.body = patch.body.trim();
    if (patch.status === 'open' || patch.status === 'resolved') c.status = patch.status;
    c.updatedAt = new Date().toISOString();
    this.save();
    return c;
  }

  reply(id: string, author: string, body: string): Comment | undefined {
    const c = this.comments.find((x) => x.id === id);
    if (!c || !body.trim()) return undefined;
    (c.replies ??= []).push({ id: crypto.randomBytes(3).toString('hex'), author: author || 'reviewer', body: body.trim(), at: new Date().toISOString() });
    c.updatedAt = new Date().toISOString();
    this.save();
    return c;
  }

  remove(id: string): boolean {
    const n = this.comments.length;
    this.comments = this.comments.filter((c) => c.id !== id);
    if (this.comments.length === n) return false;
    this.save();
    return true;
  }

  clearResolved(): number {
    const n = this.comments.length;
    this.comments = this.comments.filter((c) => c.status !== 'resolved');
    this.save();
    return n - this.comments.length;
  }

  private quote(rel: string, from: number, to: number): string | undefined {
    try {
      const abs = path.join(this.root, rel);
      if (fs.statSync(abs).size > 5_000_000) return undefined;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const end = Math.min(to, from + QUOTE_LINES - 1);
      const got = lines.slice(from - 1, end).map((l) => l.replace(/\r$/, ''));
      if (!got.length) return undefined;
      return got.join('\n') + (to > end ? '\n…' : '');
    } catch {
      return undefined;
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const sorted = [...this.comments].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.createdAt.localeCompare(b.createdAt));
    const text = JSON.stringify({ version: 1, comments: sorted } satisfies Store, null, 2) + '\n';
    writeAtomic(this.jsonPath, text);
    this.lastWritten = text;
    this.writeMarkdown();
    this.emit();
  }

  private writeMarkdown(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.mdPath, toMarkdown(this.comments, path.relative(this.root, this.jsonPath).split(path.sep).join('/')));
    } catch {
      // the folder went away; the next save makes it again
    }
  }
}

/** What to tell an agent: where the feedback is, and how to answer it. */
export function agentPrompt(mdRel: string, jsonRel: string): string {
  return (
    `Read ${mdRel}. It lists review comments on files in this folder (path:line, the quoted code, and the comment). ` +
    `Work through each open comment: make the change it asks for, then set that comment's "status" to "resolved" in ${jsonRel} ` +
    `and add a reply saying what you did. If you can't or shouldn't act on one, leave it open and reply with why. ` +
    `(\`npx folderview review\` prints the open comments too.)`
  );
}

export function toMarkdown(comments: Comment[], jsonRel: string, { openOnly = false } = {}): string {
  const open = comments.filter((c) => c.status === 'open');
  const done = openOnly ? [] : comments.filter((c) => c.status === 'resolved');
  const out: string[] = [
    '# Review comments',
    '',
    openOnly ? `${open.length} open` : `${open.length} open · ${done.length} resolved · updated ${new Date().toISOString()}`,
    '',
    '<!-- Written by folderview. Do not edit this file: it is regenerated from ' + jsonRel + '. -->',
    '',
    '## How to work through this (for an agent)',
    '',
    '- Each comment is on a file, or on lines of it (`path:line`). Paths are relative to the folder folderview serves.',
    '- The quoted code is what the lines said when the comment was left; the file may have moved on since, so find the code, not just the line number.',
    `- When a comment is dealt with, set its \`"status"\` to \`"resolved"\` in \`${jsonRel}\` and, if there is something to say, add a reply:`,
    '  `"replies": [{ "id": "a1", "author": "agent", "body": "Done: …", "at": "<ISO time>" }]`. The reviewer sees it live.',
    '- Leave comments you could not act on open, with a reply that says why.',
    '',
  ];
  const section = (title: string, list: Comment[]) => {
    if (!list.length) return;
    out.push(`## ${title}`, '');
    let file = '';
    for (const c of list) {
      if (c.path !== file) {
        file = c.path;
        out.push(`### ${file || '(the whole folder)'}`, '');
      }
      const where = c.line ? `${c.path}:${c.line}${c.endLine ? '-' + c.endLine : ''}` : `${c.path || '.'} (whole file)`;
      out.push(`#### \`${where}\` — ${c.author}${c.commit ? ` @ ${c.commit}` : ''} · id \`${c.id}\``, '');
      if (c.quote) out.push('```' + langOf(c.path), c.quote, '```', '');
      out.push(c.body, '');
      for (const r of c.replies ?? []) out.push(`> **${r.author}**: ${r.body.replace(/\n/g, '\n> ')}`, '');
    }
  };
  const order = (a: Comment, b: Comment) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
  section('Open', [...open].sort(order));
  section('Resolved', [...done].sort(order));
  if (!comments.length) out.push('No comments yet.', '');
  else if (openOnly && !open.length) out.push('No open comments.', '');
  return out.join('\n');
}

function langOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) && p.includes('.') ? ext : '';
}

function writeAtomic(file: string, text: string): void {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse a rename over a file another process holds open; write in place instead
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

function isComment(x: unknown): x is Comment {
  if (!x || typeof x !== 'object') return false;
  const c: Partial<Record<keyof Comment, unknown>> = x;
  return typeof c.id === 'string' && typeof c.path === 'string' && typeof c.body === 'string' && (c.status === 'open' || c.status === 'resolved');
}
