// Glob patterns in the .gitignore style, used for excludes (--exclude, CODEVIEW_EXCLUDE, .codeviewignore, config)
// and for search's "files to include".
//
//   *.log        a name anywhere
//   dist/        a folder anywhere (and everything in it)
//   /build       only at the top
//   docs/**/*.md a path pattern (anchored at the top)
//   !keep.log    an exception to an earlier pattern

export interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export function toRegex(glob: string): RegExp {
  let g = glob;
  const anchored = g.startsWith('/') || g.replace(/\/$/, '').includes('/');
  g = g.replace(/^\//, '').replace(/\/$/, '');
  let src = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? '';
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        src += '(?:.*/)?';
      } else src += '.*';
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end < 0) src += '\\[';
      else {
        src += '[' + g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else src += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp((anchored ? '^' : '(?:^|/)') + src + '$', process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
}

export function parseRules(lines: string[]): Rule[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      const body = negate ? l.slice(1) : l;
      return { re: toRegex(body), negate, dirOnly: body.endsWith('/') };
    });
}

/** A test for root-relative paths: true when the path, or a folder above it, is excluded. */
export function excluder(rules: Rule[]): (rel: string, isDir?: boolean) => boolean {
  if (!rules.length) return () => false;
  const one = (p: string, isDir: boolean): boolean => {
    let out = false;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(p)) out = !r.negate;
    return out;
  };
  const cache = new Map<string, boolean>();
  return (rel, isDir = false) => {
    const key = rel + (isDir ? '/' : '');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const parts = rel.split('/').filter(Boolean);
    let out = false;
    for (let i = 1; i <= parts.length && !out; i++) out = one(parts.slice(0, i).join('/'), i < parts.length || isDir);
    if (cache.size > 50_000) cache.clear();
    cache.set(key, out);
    return out;
  };
}

/** Search's include box: "*.ts, src/**, !*.test.ts" (comma-separated; ! excludes). */
export function pathFilter(spec: string): (p: string) => boolean {
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const inc = parts.filter((p) => !p.startsWith('!')).map((p) => excluder(parseRules([p])));
  const exc = excluder(parseRules(parts.filter((p) => p.startsWith('!')).map((p) => p.slice(1))));
  return (p) => (!inc.length || inc.some((t) => t(p))) && !exc(p);
}
