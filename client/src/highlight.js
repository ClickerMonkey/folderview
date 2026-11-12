// The built-in highlighter: what draws code until Shiki's grammar for the language has loaded (and for files too big
// for Shiki). It finds the same kinds harness draws: comments, strings, numbers, literals and keywords.
// It returns one HTML string per line, so a token that spans lines (a block comment) is closed and reopened.
import { esc } from './util.js';

const JS_KW =
  'abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield';
const C_KW =
  'auto bool break case char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while include define ifdef ifndef endif pragma';
const CS_JAVA_KW =
  'abstract as base bool boolean break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extends extern false final finally fixed float for foreach goto if implicit implements import in int interface internal is lock long namespace new null object operator out override package params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct super switch synchronized this throw throws true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await get set record yield';
const GO_KW = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota string int bool error byte rune float64 int64 uint';
const RS_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while i32 i64 u8 u32 u64 usize f32 f64 bool str String Vec Option Some None Result Ok Err';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print match case';
const SH_KW = 'if then else elif fi for while until do done case esac in function return local export source alias echo exit set unset readonly shift trap cd test true false';
const RB_KW = 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor';
const SQL_KW =
  'select from where and or not insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer on group by order asc desc limit offset having as distinct union all null is in like between case when then else end exists default unique check constraint begin commit rollback with returning integer text varchar boolean';
const LUA_KW = 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while';
const PS_KW = 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using while';
const CSS_KW = 'important media import supports keyframes font-face from to and not only screen print';

const words = (s) => new Set(s.split(' '));

/** language families: how comments and strings look, and the keywords */
const LANGS = {
  js: { line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], kw: words(JS_KW), regex: true },
  c: { line: '//', block: ['/*', '*/'], quotes: ['"', "'"], kw: words(C_KW), pre: true },
  cs: { line: '//', block: ['/*', '*/'], quotes: ['"', "'"], kw: words(CS_JAVA_KW), at: true },
  go: { line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], kw: words(GO_KW) },
  rs: { line: '//', block: ['/*', '*/'], quotes: ['"'], kw: words(RS_KW) },
  py: { line: '#', quotes: ['"""', "'''", '"', "'"], kw: words(PY_KW), at: true },
  sh: { line: '#', quotes: ['"', "'"], kw: words(SH_KW), vars: true },
  rb: { line: '#', quotes: ['"', "'"], kw: words(RB_KW) },
  yaml: { line: '#', quotes: ['"', "'"], kw: words('true false null yes no on off'), keys: true },
  toml: { line: '#', quotes: ['"""', '"', "'"], kw: words('true false'), keys: true },
  ini: { line: ';', alt: '#', quotes: ['"'], kw: words('true false'), keys: true },
  sql: { line: '--', block: ['/*', '*/'], quotes: ["'", '"'], kw: words(SQL_KW), nocase: true },
  lua: { line: '--', quotes: ['"', "'"], kw: words(LUA_KW) },
  ps: { line: '#', block: ['<#', '#>'], quotes: ['"', "'"], kw: words(PS_KW), vars: true, nocase: true },
  css: { block: ['/*', '*/'], quotes: ['"', "'"], kw: words(CSS_KW), css: true },
  json: { line: '//', block: ['/*', '*/'], quotes: ['"'], kw: words('true false null') },
  md: { md: true },
  html: { html: true },
};

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', mts: 'js', cts: 'js', tsx: 'js', vue: 'html', svelte: 'html', astro: 'html',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cxx: 'c', m: 'c', glsl: 'c', frag: 'c', vert: 'c', wgsl: 'rs', hlsl: 'c', shader: 'c',
  cs: 'cs', java: 'cs', kt: 'cs', kts: 'cs', scala: 'cs', swift: 'cs', dart: 'cs', groovy: 'cs', gradle: 'cs', php: 'cs',
  go: 'go', rs: 'rs', zig: 'rs',
  py: 'py', pyi: 'py', ipy: 'py', r: 'py', jl: 'py', nim: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', env: 'sh', dockerfile: 'sh', makefile: 'sh', mk: 'sh', cmake: 'sh', gitignore: 'sh', npmrc: 'ini', editorconfig: 'ini',
  rb: 'rb', rake: 'rb', gemspec: 'rb', pl: 'rb', ex: 'rb', exs: 'rb', cr: 'rb',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  sql: 'sql', lua: 'lua', ps1: 'ps', psm1: 'ps', psd1: 'ps',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', map: 'json', lock: 'json', har: 'json', ipynb: 'json', geojson: 'json', gltf: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xhtml: 'html', plist: 'html', csproj: 'html', xaml: 'html',
};

/** the language for a file name, or '' for plain text */
export function langFor(name) {
  const n = name.toLowerCase();
  if (n === 'dockerfile' || n === 'makefile' || n.startsWith('.env') || n === '.gitignore' || n === '.gitattributes' || n === '.dockerignore') return 'sh';
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
  return EXT[ext] || '';
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map();

function compile(id) {
  if (compiled.has(id)) return compiled.get(id);
  const L = LANGS[id];
  const com = [];
  if (L.block) com.push(`${reEsc(L.block[0])}[\\s\\S]*?(?:${reEsc(L.block[1])}|$)`);
  if (L.line) com.push(`${reEsc(L.line)}[^\\n]*`);
  if (L.alt) com.push(`${reEsc(L.alt)}[^\\n]*`);
  const str = (L.quotes || []).map((q) =>
    q.length === 3 ? `${reEsc(q)}[\\s\\S]*?(?:${reEsc(q)}|$)` : q === '`' ? '`(?:\\\\[\\s\\S]|[^`\\\\])*`?' : `${reEsc(q)}(?:\\\\.|[^${reEsc(q)}\\\\\\n])*${reEsc(q)}?`,
  );
  const parts = [];
  if (com.length) parts.push(`(?<com>${com.join('|')})`);
  if (str.length) parts.push(`(?<str>${str.join('|')})`);
  if (L.vars) parts.push('(?<var>\\$\\{?[\\w@#?*!-]+\\}?)');
  if (L.at || id === 'js') parts.push('(?<at>@[\\w.]+)');
  if (L.css) parts.push('(?<at>@[\\w-]+)|(?<num>#[\\da-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:px|em|rem|vh|vw|%|s|ms|deg|fr|ch)?\\b)|(?<key>[\\w-]+(?=\\s*:[^:]))|(?<word>[\\w-]+)');
  else {
    parts.push('(?<num>\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)[nlLfFuU]*\\b)');
    if (L.pre) parts.push('(?<pre>^\\s*#\\s*\\w+)');
    parts.push('(?<word>[A-Za-z_$][\\w$]*)');
  }
  const re = new RegExp(parts.join('|'), 'gm');
  compiled.set(id, re);
  return re;
}

/** text → html lines */
export function highlight(text, name) {
  const id = langFor(name);
  if (!id) return plain(text);
  if (id === 'md') return mdLines(text);
  if (id === 'html') return htmlLines(text);
  const L = LANGS[id];
  const re = compile(id);
  const out = [];
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(['', text.slice(last, m.index)]);
    const g = m.groups;
    let cls = '';
    if (g.com) cls = 'com';
    else if (g.str) cls = /^\s*:/.test(text.slice(re.lastIndex, re.lastIndex + 3)) && !L.css ? 'key' : 'str';
    else if (g.num) cls = 'num';
    else if (g.at) cls = 'at';
    else if (g.var) cls = 'var';
    else if (g.pre) cls = 'kw';
    else if (g.key) cls = 'key';
    else if (g.word) {
      const w = g.word;
      const after = text.slice(re.lastIndex, re.lastIndex + 2);
      if (LITERALS.has(w)) cls = 'lit';
      else if (L.kw.has(L.nocase ? w.toLowerCase() : w)) cls = 'kw';
      else if (L.keys && /^\s*[:=]/.test(after) && lineStart(text, m.index)) cls = 'key';
      else if (L.css) cls = '';
      else if (after[0] === '(') cls = 'fn';
      else if (/^[A-Z][a-z0-9]/.test(w) && id !== 'sql') cls = 'type';
      else if (/^[A-Z][A-Z0-9_]+$/.test(w) && w.length > 1) cls = 'const';
    }
    out.push([cls, m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(['', text.slice(last)]);
  return toLines(out);
}

/** only whitespace (or a "- " list marker) between the line start and i */
function lineStart(text, i) {
  const s = text.lastIndexOf('\n', i - 1) + 1;
  return /^[\s-]*$/.test(text.slice(s, i));
}

const KIND = { com: 'comment', str: 'string', num: 'number', const: 'number', kw: 'keyword', lit: 'literal', pre: 'keyword' };
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity']);

function toLines(tokens) {
  const lines = [''];
  for (const [raw, t] of tokens) {
    const cls = KIND[raw] || '';
    const segs = t.split('\n');
    segs.forEach((seg, i) => {
      if (i > 0) lines.push('');
      if (seg) lines[lines.length - 1] += cls ? `<span class="tok-${cls}">${esc(seg)}</span>` : esc(seg);
    });
  }
  return lines.map((l) => l.replace(/\r/g, ''));
}

export const plain = (text) => text.replace(/\r/g, '').split('\n').map(esc);

function mdLines(text) {
  let fence = false;
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        return `<span class="tok-comment">${esc(l)}</span>`;
      }
      if (fence) return `<span class="tok-string">${esc(l)}</span>`;
      if (/^#{1,6} /.test(l)) return `<span class="tok-keyword">${esc(l)}</span>`;
      if (/^\s*>/.test(l)) return `<span class="tok-comment">${esc(l)}</span>`;
      return esc(l)
        .replace(/^(\s*)([-*+]|\d+\.)(\s)/, '$1<span class="tok-number">$2</span>$3')
        .replace(/`[^`]+`/g, (s) => `<span class="tok-string">${s}</span>`)
        .replace(/\[[^\]]*\]\([^)]*\)/g, (s) => `<span class="tok-keyword">${s}</span>`);
    });
}

function htmlLines(text) {
  const re = /(?<com><!--[\s\S]*?(?:-->|$))|(?<tag><\/?[A-Za-z][\w:.-]*|\/?>)|(?<attr>[\w:@.#-]+(?=\s*=))|(?<str>"[^"]*"?|'[^']*'?)|(?<ent>&[#\w]+;)/g;
  const out = [];
  let last = 0,
    inTag = false,
    m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(['', text.slice(last, m.index)]);
    const g = m.groups;
    let cls = '';
    if (g.com) cls = 'com';
    else if (g.tag) {
      cls = 'kw';
      inTag = !g.tag.endsWith('>');
    } else if (g.attr) cls = inTag ? 'key' : '';
    else if (g.str) cls = inTag ? 'str' : '';
    else if (g.ent) cls = 'num';
    out.push([cls, m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(['', text.slice(last)]);
  return toLines(out);
}
