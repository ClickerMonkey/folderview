// Syntax highlighting with Shiki, as the harness web app does it: TextMate grammars on Shiki's JavaScript regex engine
// (no wasm), each grammar loaded the first time a file in its language is drawn. Tokens are read by scope into a few
// kinds (comment, string, number, literal, keyword) and coloured by the page's own tokens, light or dark. Until a
// grammar has loaded, and for files too big to tokenize quickly, the built-in highlighter draws instead.
import { esc } from './util.js';
import { highlight as builtin } from './highlight.js';

const SCOPES_ONLY = { name: 'codeview-scopes', type: 'light', fg: '#000000', bg: '#ffffff', settings: [] };

/** Scope prefixes, most specific first, and the kind each draws as (harness's table). */
const SCOPE_KINDS = [
  ['comment', 'comment'],
  ['punctuation.definition.comment', 'comment'],
  ['string', 'string'],
  ['punctuation.definition.string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.language', 'literal'],
  ['support.constant', 'literal'],
  ['constant.character', 'literal'],
  ['keyword.operator', 'plain'],
  ['keyword', 'keyword'],
  ['storage', 'keyword'],
  ['markup.heading', 'keyword'],
  ['markup.inline.raw', 'string'],
  ['markup.fenced_code', 'string'],
  ['entity.name.tag', 'keyword'],
];

export function kindOf(scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    const found = SCOPE_KINDS.find(([prefix]) => scope === prefix || scope.startsWith(prefix + '.'));
    if (found) return found[1];
  }
  return 'plain';
}

/** Languages by file name, for names and extensions Shiki's own aliases don't cover. */
const NAMES = { dockerfile: 'docker', makefile: 'make', 'cmakelists.txt': 'cmake', '.gitignore': 'shellscript', '.dockerignore': 'shellscript', '.npmrc': 'ini', '.editorconfig': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', 'tsconfig.json': 'jsonc', 'jsconfig.json': 'jsonc', '.babelrc': 'json', gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'groovy', 'caddyfile': 'shellscript' };
const EXTS = {
  h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', kt: 'kotlin', kts: 'kotlin', rs: 'rust', py: 'python', pyi: 'python', rb: 'ruby',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', env: 'dotenv', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', yml: 'yaml',
  md: 'markdown', mdx: 'mdx', htm: 'html', xhtml: 'html', svg: 'xml', plist: 'xml', csproj: 'xml', xaml: 'xml', ipynb: 'json', gltf: 'json', webmanifest: 'json',
  geojson: 'json', map: 'json', har: 'json', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', fs: 'fsharp', clj: 'clojure',
  tf: 'terraform', hcl: 'hcl', vert: 'glsl', frag: 'glsl', wgsl: 'wgsl', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  conf: 'ini', cfg: 'ini', properties: 'properties', mmd: 'mermaid', mermaid: 'mermaid', gradle: 'groovy', txt: '', log: 'log', lock: '',
};

export function langOf(name) {
  const n = name.toLowerCase().slice(name.lastIndexOf('/') + 1);
  if (NAMES[n]) return NAMES[n];
  if (n.startsWith('.env')) return 'dotenv';
  if (n.startsWith('dockerfile')) return 'docker';
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
  return ext in EXTS ? EXTS[ext] : ext;
}

let core, langs, coreNow; // coreNow: the loaded core, once any grammar is in
const loaded = new Set();
const loading = new Map();

const languages = () =>
  (langs ??= import('shiki/langs').then(
    ({ bundledLanguages, bundledLanguagesAlias }) => new Map([...Object.entries(bundledLanguagesAlias), ...Object.entries(bundledLanguages)]),
  ));

async function load(lang) {
  const grammar = (await languages()).get(lang);
  if (!grammar) return false;
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({ themes: [SCOPES_ONLY], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }),
  );
  const c = await core;
  await c.loadLanguage(grammar);
  coreNow = c;
  loaded.add(lang);
  return true;
}

/** Load the grammar for this file's language; true once Shiki can draw it (false if it never will). */
export function prepare(name) {
  const lang = langOf(name);
  if (!lang) return Promise.resolve(false);
  if (loaded.has(lang)) return Promise.resolve(true);
  if (!loading.has(lang)) loading.set(lang, load(lang).catch(() => false));
  return loading.get(lang);
}

/** Text this long or longer is drawn by the built-in highlighter only (Shiki would take seconds on a phone). */
const SHIKI_MAX = 400_000;
const SHIKI_MAX_LINES = 8000;

/** HTML for each line: Shiki's when the grammar is in, else the built-in highlighter's. */
export function highlightLines(text, name) {
  const lang = langOf(name);
  if (lang && loaded.has(lang) && text.length < SHIKI_MAX) {
    const lines = shikiLines(text, lang);
    if (lines) return lines;
  }
  return builtin(text, name);
}

function shikiLines(text, lang) {
  if (!coreNow) return undefined;
  if (text.split('\n', SHIKI_MAX_LINES + 1).length > SHIKI_MAX_LINES) return undefined;
  try {
    const rows = coreNow.codeToTokensBase(text.replace(/\r\n?/g, '\n'), { lang, theme: SCOPES_ONLY.name, includeExplanation: 'scopeName' });
    return rows.map((row) => {
      let html = '',
        kind = 'plain',
        buf = '';
      const flush = () => {
        if (!buf) return;
        html += kind === 'plain' ? esc(buf) : `<span class="tok-${kind}">${esc(buf)}</span>`;
        buf = '';
      };
      for (const token of row) {
        const parts = token.explanation ?? [{ content: token.content, scopes: [] }];
        for (const part of parts) {
          const k = kindOf(part.scopes.map((s) => s.scopeName));
          if (k !== kind) {
            flush();
            kind = k;
          }
          buf += part.content;
        }
      }
      flush();
      return html;
    });
  } catch {
    // Shiki gives up on a line that takes too long; the built-in highlighter draws this one
    return undefined;
  }
}
