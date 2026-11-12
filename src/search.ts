// The file list (for quick open and name search) and full-text search across it.
import fs from 'node:fs';
import path from 'node:path';
import { isHidden, walk, type Scope } from './files.js';
import type { Git } from './git.js';
import { pathFilter } from './glob.js';

export interface Match {
  line: number; // 1-based
  text: string;
  /** [start, end) character ranges of the hits in text */
  hits: [number, number][];
}

export interface FileHits {
  path: string;
  matches: Match[];
  /** the name matched (a name search, or the query appears in the path) */
  name?: boolean;
}

export interface SearchQuery {
  q: string;
  /** a folder (root-relative) to search under; '' for everything */
  scope: string;
  regex: boolean;
  caseSensitive: boolean;
  word: boolean;
  /** glob-ish filters on the path: "*.ts, src/**" includes; "!*.test.ts" excludes */
  include: string;
}

export interface SearchResult {
  files: FileHits[];
  total: number;
  truncated: boolean;
  searched: number;
  ms: number;
  error?: string;
}

const MAX_FILE = 2 * 1024 * 1024;
const MAX_MATCHES = 3000;
const MAX_PER_FILE = 200;
const LINE_CAP = 400;

export class FileIndex {
  private cached: { at: number; files: string[] } | undefined;
  constructor(
    private readonly scope: Scope,
    private readonly git: Git | undefined,
    private readonly maxFile = MAX_FILE,
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async files(): Promise<string[]> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.files;
    let files: string[] | undefined;
    if (this.git) files = await this.git.files().catch(() => undefined);
    files ??= walk(this.scope);
    files = files.filter((f) => !f.split('/').some((p) => isHidden(this.scope, p)) && !this.scope.excluded(f) && fs.existsSync(path.join(this.scope.root, f)));
    this.cached = { at: Date.now(), files };
    return files;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const t0 = Date.now();
    const result: SearchResult = { files: [], total: 0, truncated: false, searched: 0, ms: 0 };
    let re: RegExp;
    try {
      re = makeRegex(query);
    } catch (e) {
      return { ...result, error: e instanceof Error ? e.message : String(e) };
    }
    const prefix = query.scope.replace(/^\/+|\/+$/g, '');
    const filter = pathFilter(query.include);
    const all = (await this.files()).filter((f) => (!prefix || f.startsWith(prefix + '/')) && filter(f));
    // in git, git grep says which files can match; only those are read (names are still checked on every file)
    const maybe = this.git ? await this.git.grepFiles(query.q, { regex: query.regex, caseSensitive: query.caseSensitive, word: query.word }) : undefined;
    // read many files at once (each read is mostly waiting on the disk), keep the results in path order
    const found: (FileHits | undefined)[] = new Array(all.length);
    let next = 0;
    const worker = async () => {
      while (next < all.length && result.total < MAX_MATCHES) {
        const idx = next++;
        const file = all[idx] ?? '';
        const hits: FileHits = { path: file, matches: [] };
        re.lastIndex = 0;
        if (re.test(file.slice(file.lastIndexOf('/') + 1))) hits.name = true;
        const text = maybe && !maybe.has(file) ? undefined : await readText(path.join(this.scope.root, file), this.maxFile);
        if (maybe && !maybe.has(file)) result.searched++;
        if (text !== undefined) {
          result.searched++;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.matches.length < MAX_PER_FILE; i++) {
            const line = (lines[i] ?? '').replace(/\r$/, '');
            const ranges = hitsIn(re, line);
            if (ranges.length) hits.matches.push(clip(i + 1, line, ranges));
          }
        }
        if (hits.matches.length || hits.name) {
          found[idx] = hits;
          result.total += hits.matches.length || 1;
        }
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    result.truncated = next < all.length;
    result.files = found.filter((f): f is FileHits => f !== undefined);
    result.ms = Date.now() - t0;
    return result;
  }
}

function makeRegex(q: SearchQuery): RegExp {
  let src = q.regex ? q.q : q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.word) src = `\\b(?:${src})\\b`;
  const re = new RegExp(src, q.caseSensitive ? 'g' : 'gi');
  if (re.test('')) throw new Error('That pattern matches nothing at all (an empty match).');
  return re;
}

function hitsIn(re: RegExp, line: string): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) && out.length < 50) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** long lines are cut around the first hit so the result stays readable */
function clip(line: number, text: string, hits: [number, number][]): Match {
  if (text.length <= LINE_CAP) return { line, text, hits };
  const first = hits[0]?.[0] ?? 0;
  const start = Math.max(0, first - 80);
  const end = Math.min(text.length, start + LINE_CAP);
  const lead = start > 0 ? '…' : '';
  const shift = start - lead.length;
  return {
    line,
    text: lead + text.slice(start, end) + (end < text.length ? '…' : ''),
    hits: hits.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - shift, b - shift]),
  };
}

async function readText(abs: string, max: number): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}
