// Git, when the folder is in a repository: each file's state, the branch, diffs, a file's history, and old versions.
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export type FileState = 'new' | 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict' | 'ignored';

export interface Change {
  path: string; // root-relative
  state: FileState;
  staged: boolean;
  unstaged: boolean;
  from?: string; // the old path of a rename
  add?: number;
  del?: number;
}

export interface Status {
  repo: true;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  head?: string; // short commit
  changes: Change[];
  /** ignored folders and files (root-relative, folders end with /) */
  ignored: string[];
}

export interface Commit {
  hash: string;
  author: string;
  time: number;
  subject: string;
}

export class Git {
  /** the repository's top folder, and the served root's path inside it ('' at the top) */
  private constructor(
    readonly top: string,
    readonly prefix: string,
    private readonly root: string,
  ) {}

  static async open(root: string): Promise<Git | undefined> {
    try {
      const top = (await run(root, ['rev-parse', '--show-toplevel'])).trim();
      if (!top) return undefined;
      const realTop = fs.realpathSync(top);
      const realRoot = fs.realpathSync(root);
      const prefix = path.relative(realTop, realRoot).split(path.sep).join('/');
      return new Git(realTop, prefix, root);
    } catch {
      return undefined;
    }
  }

  /** a repo-relative path → root-relative, or undefined when it is outside the served folder */
  private fromRepo(p: string): string | undefined {
    if (!this.prefix) return p;
    return p === this.prefix ? '' : p.startsWith(this.prefix + '/') ? p.slice(this.prefix.length + 1) : undefined;
  }

  private git(args: string[]): Promise<string> {
    return run(this.top, ['-c', 'core.quotepath=off', ...args]);
  }

  async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '-q', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<Status> {
    const scope = this.prefix ? ['--', this.prefix] : [];
    const [raw, ignoredRaw, head] = await Promise.all([
      this.git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all', ...scope]),
      this.git(['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z', ...scope]).catch(() => ''),
      this.git(['rev-parse', '--short', 'HEAD']).catch(() => ''),
    ]);
    const recs = raw.split('\0');
    const status: Status = { repo: true, branch: '', ahead: 0, behind: 0, changes: [], ignored: [] };
    if (head.trim()) status.head = head.trim();
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r) continue;
      if (r.startsWith('## ')) {
        // "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main", "## HEAD (no branch)"
        const body = r.slice(3).replace(/^No commits yet on /, '');
        const at = body.indexOf(' [');
        const names = at < 0 ? body : body.slice(0, at);
        const track = at < 0 ? '' : body.slice(at);
        const [branch = '', upstream] = names.split('...');
        status.branch = branch;
        if (upstream) status.upstream = upstream;
        const a = /ahead (\d+)/.exec(track),
          b = /behind (\d+)/.exec(track);
        status.ahead = a ? Number(a[1]) : 0;
        status.behind = b ? Number(b[1]) : 0;
        continue;
      }
      const x = r[0] ?? ' ',
        y = r[1] ?? ' ';
      const file = r.slice(3);
      let from: string | undefined;
      if (x === 'R' || x === 'C') from = recs[++i];
      const rel = this.fromRepo(file);
      if (rel === undefined) continue;
      const change: Change = { path: rel, state: stateOf(x, y), staged: x !== ' ' && x !== '?', unstaged: y !== ' ' };
      if (from) change.from = this.fromRepo(from) ?? from;
      status.changes.push(change);
    }
    for (const p of ignoredRaw.split('\0')) {
      const rel = p && this.fromRepo(p.replace(/\/$/, ''));
      if (rel) status.ignored.push(p.endsWith('/') ? rel + '/' : rel);
    }
    await this.counts(status.changes);
    return status;
  }

  /** lines added and removed per changed file, against HEAD (whole file for new ones) */
  private async counts(changes: Change[]): Promise<void> {
    if (!changes.length) return;
    const byPath = new Map(changes.map((c) => [c.path, c]));
    const scope = this.prefix ? ['--', this.prefix] : [];
    const base = (await this.hasHead()) ? ['diff', 'HEAD'] : ['diff', '--cached'];
    const out = await this.git([...base, '--numstat', '-z', ...scope]).catch(() => '');
    const recs = out.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(recs[i] ?? '');
      if (!m) continue;
      let file = m[3] ?? '';
      if (!file) {
        i++; // a rename: "old\0new"
        file = recs[++i] ?? '';
      }
      const c = byPath.get(this.fromRepo(file) ?? '');
      if (c && m[1] !== '-') {
        c.add = Number(m[1]);
        c.del = Number(m[2]);
      }
    }
    for (const c of changes) {
      if (c.state !== 'new' || c.add !== undefined) continue;
      try {
        const abs = path.join(this.root, c.path);
        if (fs.statSync(abs).size > 2_000_000) continue;
        const t = fs.readFileSync(abs, 'utf8');
        if (!t.includes('\0')) c.add = t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0;
      } catch {
        // gone again
      }
    }
  }

  private repoPath(rel: string): string {
    return this.prefix ? (rel ? this.prefix + '/' + rel : this.prefix) : rel;
  }

  /** a unified diff of one file against HEAD (staged and unstaged together); a new file diffs against nothing */
  async diff(rel: string): Promise<string> {
    const p = this.repoPath(rel);
    const tracked = await this.git(['ls-files', '--error-unmatch', '--', p]).then(
      () => true,
      () => false,
    );
    if (!tracked) {
      // untracked: --no-index exits 1 when the files differ, which is the point
      return run(this.top, ['diff', '--no-index', '--no-color', '--', nullDevice(), p], [0, 1]);
    }
    const base = (await this.hasHead()) ? ['diff', 'HEAD'] : ['diff', '--cached'];
    return this.git([...base, '--no-color', '-M', '--', p]);
  }

  /** the file as of a commit (HEAD by default) */
  show(rel: string, rev = 'HEAD'): Promise<string> {
    return this.git(['show', `${rev}:${this.repoPath(rel)}`]);
  }

  /** the file's bytes as of a commit (for binary files: images to compare) */
  showRaw(rel: string, rev = 'HEAD'): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile('git', ['show', `${rev}:${this.repoPath(rel)}`], { cwd: this.top, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
  }

  async log(rel: string, limit = 30, skip = 0): Promise<Commit[]> {
    const out = await this.git(['log', '--follow', `-n${limit}`, `--skip=${skip}`, '--format=%h%x1f%an%x1f%at%x1f%s%x1e', '--', this.repoPath(rel)]).catch(() => '');
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash = '', author = '', time = '0', subject = ''] = r.split('\x1f');
        return { hash, author, time: Number(time) * 1000, subject };
      });
  }

  /** the diff a commit made to one file */
  commitDiff(rel: string, hash: string): Promise<string> {
    return this.git(['show', '--no-color', '--format=%H%n%an <%ae>%n%ad%n%n%B', '-M', hash, '--', this.repoPath(rel)]);
  }

  /**
   * The repository's commits (those touching the served folder), newest first, each marked pushed or local, plus
   * the upstream's commits not pulled yet (on the first page).
   */
  async history(skip = 0, limit = 50, q = ''): Promise<History> {
    const scope = this.prefix ? ['--', this.prefix] : [];
    const none = () => '';
    // a search: words in the message (any case), or the start of a hash
    const find = q ? ['-i', '-F', `--grep=${q}`] : [];
    const first = !skip && !q;
    // every question at once (each git call costs a process start, slow on Windows); the ones that can't apply
    // (no upstream, no remote, no commits yet) just fail to ''
    const [remoteList, up, out, hashOut, inRaw, inCount, localRaw, localScoped] = await Promise.all([
      this.git(['remote']).catch(none),
      this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(none),
      this.git(['log', `-n${limit + 1}`, `--skip=${skip}`, `--format=${LOG_FORMAT}`, ...find, 'HEAD', ...scope]).catch(none),
      /^[0-9a-f]{4,40}$/i.test(q) && !skip ? this.git(['log', '-n1', `--format=${LOG_FORMAT}`, q, '--']).catch(none) : '',
      first ? this.git(['log', '-n50', `--format=${LOG_FORMAT}`, 'HEAD..@{u}', ...scope]).catch(none) : '',
      first ? this.git(['rev-list', '--count', 'HEAD..@{u}', ...scope]).catch(none) : '',
      // the commits only here (up to a limit, so a never-pushed giant history stays quick)
      this.git(['rev-list', `--max-count=${LOCAL_CAP + 1}`, 'HEAD', '--not', '--remotes']).catch(none),
      first && this.prefix ? this.git(['rev-list', '--count', `--max-count=${LOCAL_CAP + 1}`, 'HEAD', '--not', '--remotes', ...scope]).catch(none) : '',
    ]);
    const remotes = remoteList.trim() !== '';
    const upstream = up.trim() || undefined;
    const h: History = { commits: [], incoming: [], incomingTotal: 0, more: false, remotes, ...(upstream ? { upstream } : {}) };
    let all = parseLog(out);
    h.more = all.length > limit;
    all = all.slice(0, limit);
    const hit = parseLog(hashOut)[0];
    if (hit && !all.some((c) => c.full === hit.full)) all.unshift(hit);
    h.commits = all.map((c) => ({ ...c, state: remotes ? 'pushed' : 'unknown' }));
    const localList = localRaw.split('\n').filter(Boolean);
    if (remotes && all.length) {
      let local = new Set(localList);
      if (localList.length > LOCAL_CAP) {
        // more unpushed commits than the list holds: ask again for just this page's stretch of time (the unpushed
        // ones no older than its oldest commit, a day's slack for clock skew)
        const oldest = Math.floor(Math.min(...all.map((c) => c.time)) / 1000 - 86400);
        local = new Set((await this.git(['rev-list', `--since=${oldest}`, 'HEAD', '--not', '--remotes']).catch(none)).split('\n').filter(Boolean));
      }
      for (const c of h.commits) if (local.has(c.full)) c.state = 'local';
    }
    if (upstream) {
      h.incoming = parseLog(inRaw).map((c) => ({ ...c, state: 'incoming' }));
      h.incomingTotal = Number(inCount.trim()) || h.incoming.length;
    }
    if (remotes && first) {
      const n = this.prefix ? Number(localScoped.trim()) || 0 : localList.length;
      h.localTotal = n > LOCAL_CAP ? `${LOCAL_CAP}+` : String(n);
    }
    return h;
  }

  /** what a commit was, and which files (in the served folder) it changed, against its first parent */
  async commitInfo(rev: string): Promise<CommitInfo> {
    const raw = await this.git(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1f%b', rev]);
    const [full = '', hash = '', author = '', email = '', time = '0', parents = '', subject = '', ...rest] = raw.replace(/\n$/, '').split('\x1f');
    const base = await this.parentOf(full);
    const scope = this.prefix ? ['--', this.prefix] : [];
    const [names, nums] = await Promise.all([
      this.git(['diff', '--name-status', '-z', '-M', base, full, ...scope]),
      this.git(['diff', '--numstat', '-z', '-M', base, full, ...scope]),
    ]);
    const files: CommitFile[] = [];
    const recs = names.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const s = recs[i];
      if (!s) continue;
      let from: string | undefined;
      let file = recs[++i] ?? '';
      if (s[0] === 'R' || s[0] === 'C') {
        from = file;
        file = recs[++i] ?? '';
      }
      const rel = this.fromRepo(file);
      if (rel === undefined) continue;
      const state: FileState = s[0] === 'A' || s[0] === 'C' ? 'added' : s[0] === 'D' ? 'deleted' : s[0] === 'R' ? 'renamed' : 'modified';
      const f: CommitFile = { path: rel, state };
      if (from) f.from = this.fromRepo(from) ?? from;
      files.push(f);
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    const nr = nums.split('\0');
    for (let i = 0; i < nr.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nr[i] ?? '');
      if (!m) continue;
      let file = m[3] ?? '';
      if (!file) {
        i++;
        file = nr[++i] ?? '';
      }
      const f = byPath.get(this.fromRepo(file) ?? '');
      if (f && m[1] !== '-') {
        f.add = Number(m[1]);
        f.del = Number(m[2]);
      }
    }
    return {
      commit: { full, hash, author, email, time: Number(time) * 1000, parents: parents.split(' ').filter(Boolean), subject, body: rest.join('\x1f').trim() },
      files,
    };
  }

  /** one file's diff in a commit, against the commit's first parent (a rename needs its old path too) */
  async commitFileDiff(rev: string, rel: string, fromRel?: string): Promise<string> {
    const full = (await this.git(['rev-parse', '--verify', rev + '^{commit}'])).trim();
    const base = await this.parentOf(full);
    const paths = [this.repoPath(rel), ...(fromRel ? [this.repoPath(fromRel)] : [])];
    return this.git(['diff', '--no-color', '-M', base, full, '--', ...paths]);
  }

  private async parentOf(full: string): Promise<string> {
    return (await this.git(['rev-parse', '--verify', '-q', full + '^1']).catch(() => '')).trim() || EMPTY_TREE;
  }

  async userName(): Promise<string> {
    return (await this.git(['config', 'user.name']).catch(() => '')).trim();
  }

  /**
   * The files (root-relative) that may match a search: git grep reads the tree far faster than one file at a time.
   * A regular expression goes to git as PCRE (close to JavaScript's); undefined when git can't run it, and the caller
   * reads every file instead.
   */
  async grepFiles(q: string, o: { regex: boolean; caseSensitive: boolean; word: boolean }): Promise<Set<string> | undefined> {
    const args = ['-c', 'core.quotepath=off', 'grep', '-l', '-I', '--null', '--untracked', o.regex ? '-P' : '-F'];
    if (!o.caseSensitive) args.push('-i');
    if (o.word) args.push('-w');
    args.push('-e', q);
    try {
      const out = await run(this.root, args, [0, 1]);
      return new Set(out.split(' ').filter(Boolean));
    } catch {
      return undefined;
    }
  }

  /** files tracked or untracked-but-not-ignored, root-relative */
  async files(): Promise<string[]> {
    const out = await run(this.root, ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z']);
    return out.split('\0').filter(Boolean);
  }
}

function stateOf(x: string, y: string): FileState {
  if (x === '?' && y === '?') return 'new';
  if (x === '!') return 'ignored';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  return 'modified';
}

export interface LogEntry extends Commit {
  full: string;
  parents: string[];
  /** pushed: on a remote; local: only here; incoming: on the upstream, not pulled; unknown: no remotes */
  state: 'pushed' | 'local' | 'incoming' | 'unknown';
}

export interface History {
  commits: LogEntry[];
  /** the upstream's commits not pulled yet (the newest 50), and how many there are in all */
  incoming: LogEntry[];
  incomingTotal: number;
  /** how many commits are not pushed ("1000+" past the count's limit); first page only */
  localTotal?: string;
  more: boolean;
  remotes: boolean;
  upstream?: string;
}

export interface CommitFile {
  path: string;
  state: FileState;
  from?: string;
  add?: number;
  del?: number;
}

export interface CommitInfo {
  commit: { full: string; hash: string; author: string; email: string; time: number; parents: string[]; subject: string; body: string };
  files: CommitFile[];
}

const LOCAL_CAP = 1000;
const LOG_FORMAT ='%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s%x1e';
/** git's empty tree: what a first commit is compared with */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function parseLog(out: string): Omit<LogEntry, 'state'>[] {
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [full = '', hash = '', author = '', time = '0', parents = '', subject = ''] = r.split('\x1f');
      return { full, hash, author, time: Number(time) * 1000, parents: parents.split(' ').filter(Boolean), subject };
    });
}

const nullDevice = () => (process.platform === 'win32' ? 'NUL' : '/dev/null');

function run(cwd: string, args: string[], ok: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 0;
      if (err && !ok.includes(code)) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}
