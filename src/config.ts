// Settings from, highest first: command-line flags, environment variables, the folder's .folderviewrc.json, the user's
// config file ($XDG_CONFIG_HOME/folderview/config.json, ~/.config/folderview/config.json), then defaults.
// Exclude patterns add up from every source, plus the folder's .folderviewignore.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Settings {
  root: string;
  port: number;
  host: string;
  /** a URL path to serve under (behind a proxy), e.g. /code/ */
  base: string;
  open: boolean;
  /** glob patterns never shown, served, searched or zipped */
  exclude: string[];
  /** exact names hidden everywhere (.git always is) */
  hide: string[];
  showSecrets: boolean;
  git: boolean;
  watch: boolean;
  readOnly: boolean;
  allowHosts: string[];
  /** when set, every request needs it (?token=… once, then a cookie) */
  token: string;
  reviewDir: string;
  /** the name shown at the top (default: the folder's name) */
  title: string;
  /** the default name on comments (default: git user.name, then the OS user) */
  author: string;
  /** files bigger than this (MB) aren't previewed as text or searched */
  maxFileMb: number;
  /** where each setting came from, for --print-config */
  sources: Record<string, string>;
  /** the files that were read */
  configFiles: string[];
}

export const DEFAULTS: Omit<Settings, 'sources' | 'configFiles'> = {
  root: '.',
  port: 4190,
  host: '127.0.0.1',
  base: '/',
  open: false,
  exclude: [],
  hide: [],
  showSecrets: false,
  git: true,
  watch: true,
  readOnly: false,
  allowHosts: [],
  token: '',
  reviewDir: '.review',
  title: '',
  author: '',
  maxFileMb: 5,
};

/** The environment variable for each setting. */
export const ENV: Record<string, keyof typeof DEFAULTS> = {
  FOLDERVIEW_ROOT: 'root',
  FOLDERVIEW_PORT: 'port',
  FOLDERVIEW_HOST: 'host',
  FOLDERVIEW_BASE: 'base',
  FOLDERVIEW_OPEN: 'open',
  FOLDERVIEW_EXCLUDE: 'exclude',
  FOLDERVIEW_HIDE: 'hide',
  FOLDERVIEW_SHOW_SECRETS: 'showSecrets',
  FOLDERVIEW_GIT: 'git',
  FOLDERVIEW_WATCH: 'watch',
  FOLDERVIEW_READ_ONLY: 'readOnly',
  FOLDERVIEW_ALLOW_HOSTS: 'allowHosts',
  FOLDERVIEW_TOKEN: 'token',
  FOLDERVIEW_REVIEW_DIR: 'reviewDir',
  FOLDERVIEW_TITLE: 'title',
  FOLDERVIEW_AUTHOR: 'author',
  FOLDERVIEW_MAX_FILE_MB: 'maxFileMb',
};

export const HELP = `folderview: browse, search and review a folder in your browser

Usage: folderview [folder] [options]
       folderview review [folder] [--all] [--json]   print the review comments (open ones, unless --all)

  folder                  the folder to serve (default: the current folder)
  -p, --port <n>          port to try first (default 4190; the next free one is used)
  -H, --host <addr>       address to listen on (default 127.0.0.1)
      --lan               listen on every interface (same as --host 0.0.0.0)
      --base <path>       serve under a URL path, e.g. code or team/code (behind a proxy;
                          in Git Bash leave off the leading /, or it becomes a Windows path)
  -o, --open              open it in your browser
  -x, --exclude <globs>   never show, serve or search these (comma-separated, repeatable):
                          "*.log,dist/,/secrets,**/*.min.js"
      --hide <names>      exact names to hide everywhere (.git always is)
      --show-secrets      show .env, *.key, *.pem and id_rsa files (hidden by default)
      --token <t>         require this token (open ?token=… once; it's kept as a cookie)
      --allow-host <h>    accept this host name too, e.g. a tunnel's (repeatable; * for any)
      --review-dir <dir>  where review comments are saved (default .review)
      --title <name>      the name shown at the top
      --author <name>     the default name on comments
      --max-file-mb <n>   bigger files aren't previewed as text or searched (default 5)
      --read-only         nobody can add comments
      --no-git            don't use git
      --no-watch          no live updates
      --print-config      show the settings and where each came from, then exit
  -v, --version
  -h, --help

Every option also reads from an environment variable (FOLDERVIEW_PORT, FOLDERVIEW_HOST,
FOLDERVIEW_EXCLUDE, FOLDERVIEW_TOKEN, …), from .folderviewrc.json in the folder, and from
~/.config/folderview/config.json. Patterns in the folder's .folderviewignore are excluded too.`;

type Raw = Partial<Record<keyof typeof DEFAULTS, unknown>>;

const LIST_KEYS = new Set(['exclude', 'hide', 'allowHosts']);
const NUM_KEYS = new Set(['port', 'maxFileMb']);

function bool(v: string): boolean {
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

export class ConfigError extends Error {}

function readJson(file: string): Raw | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return Object.fromEntries(Object.entries(data).filter(([k]) => k in DEFAULTS));
  } catch (e) {
    throw new ConfigError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env['FOLDERVIEW_CONFIG']) return path.resolve(env['FOLDERVIEW_CONFIG']);
  const base = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(base, 'folderview', 'config.json');
}

export interface Parsed {
  settings: Settings;
  help: boolean;
  version: boolean;
  printConfig: boolean;
}

/** Flags → a partial set of settings (no defaults yet). */
function parseFlags(argv: string[]): { raw: Raw; help: boolean; version: boolean; printConfig: boolean } {
  const raw: Raw = {};
  const add = (k: keyof typeof DEFAULTS, v: string) => {
    raw[k] = [...list(raw[k]), ...list(v)];
  };
  let help = false,
    version = false,
    printConfig = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new ConfigError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '--print-config':
        printConfig = true;
        break;
      case '-p':
      case '--port':
        raw.port = value();
        break;
      case '-H':
      case '--host':
        raw.host = value();
        break;
      case '--lan':
        raw.host = '0.0.0.0';
        break;
      case '--base':
        raw.base = value();
        break;
      case '-o':
      case '--open':
        raw.open = true;
        break;
      case '-x':
      case '--exclude':
        add('exclude', value());
        break;
      case '--hide':
        add('hide', value());
        break;
      case '--show-secrets':
        raw.showSecrets = true;
        break;
      case '--token':
        raw.token = value();
        break;
      case '--allow-host':
        add('allowHosts', value());
        break;
      case '--review-dir':
        raw.reviewDir = value();
        break;
      case '--title':
        raw.title = value();
        break;
      case '--author':
        raw.author = value();
        break;
      case '--max-file-mb':
        raw.maxFileMb = value();
        break;
      case '--read-only':
        raw.readOnly = true;
        break;
      case '--no-git':
        raw.git = false;
        break;
      case '--no-watch':
        raw.watch = false;
        break;
      default:
        if (a.startsWith('-') && a !== '-') throw new ConfigError(`Unknown option ${a} (see --help)`);
        if (raw.root !== undefined) throw new ConfigError(`Only one folder, please (got ${String(raw.root)} and ${a})`);
        raw.root = a;
    }
  }
  return { raw, help, version, printConfig };
}

function fromEnv(env: NodeJS.ProcessEnv): Raw {
  const raw: Raw = {};
  for (const [name, key] of Object.entries(ENV)) {
    const v = env[name];
    if (v !== undefined && v !== '') raw[key] = v;
  }
  return raw;
}

export function resolve(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Parsed {
  const flags = parseFlags(argv);
  const envRaw = fromEnv(env);
  const rootArg = flags.raw.root ?? envRaw.root;
  const root = path.resolve(cwd, typeof rootArg === 'string' ? rootArg : '.');
  const globalFile = globalConfigPath(env);
  const projectFile = path.join(root, '.folderviewrc.json');
  const globalRaw = readJson(globalFile);
  const projectRaw = readJson(projectFile);
  const layers: [string, Raw | undefined][] = [
    ['default', DEFAULTS],
    [globalFile, globalRaw],
    [projectFile, projectRaw],
    ['environment', envRaw],
    ['command line', flags.raw],
  ];
  const sources: Record<string, string> = {};
  const merged: Record<string, unknown> = {};
  for (const [source, layer] of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if (LIST_KEYS.has(k)) {
        // lists add up across sources
        const items = list(v);
        if (!items.length && source !== 'default') continue;
        merged[k] = [...list(merged[k]), ...items];
        if (items.length) sources[k] = sources[k] && sources[k] !== 'default' ? `${sources[k]} + ${source}` : source;
        else sources[k] ??= source;
        continue;
      }
      merged[k] = v;
      sources[k] = source;
    }
  }
  const ignoreFile = path.join(root, '.folderviewignore');
  if (fs.existsSync(ignoreFile)) {
    const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/);
    const pats = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (pats.length) {
      merged['exclude'] = [...list(merged['exclude']), ...pats];
      sources['exclude'] = (sources['exclude'] && sources['exclude'] !== 'default' ? sources['exclude'] + ' + ' : '') + ignoreFile;
    }
  }

  const get = (k: string) => merged[k];
  const num = (k: string): number => {
    const n = Number(get(k));
    if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${k} must be a number (got ${String(get(k))}, from ${sources[k]})`);
    return n;
  };
  const bl = (k: string): boolean => {
    const v = get(k);
    return typeof v === 'boolean' ? v : bool(String(v));
  };
  for (const k of NUM_KEYS) num(k);
  const port = num('port');
  if (!Number.isInteger(port) || port > 65535) throw new ConfigError(`port must be 0–65535 (got ${port})`);
  const base = normaliseBase(String(get('base') ?? '/'), sources['base'] ?? 'default');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ConfigError(`No such folder: ${root}`);

  const settings: Settings = {
    root,
    port,
    host: String(get('host')),
    base,
    open: bl('open'),
    exclude: list(get('exclude')),
    hide: list(get('hide')),
    showSecrets: bl('showSecrets'),
    git: bl('git'),
    watch: bl('watch'),
    readOnly: bl('readOnly'),
    allowHosts: list(get('allowHosts')),
    token: String(get('token') ?? ''),
    reviewDir: String(get('reviewDir')),
    title: String(get('title') ?? ''),
    author: String(get('author') ?? ''),
    maxFileMb: num('maxFileMb'),
    sources,
    configFiles: [globalRaw ? globalFile : '', projectRaw ? projectFile : '', fs.existsSync(ignoreFile) ? ignoreFile : ''].filter(Boolean),
  };
  return { settings, help: flags.help, version: flags.version, printConfig: flags.printConfig };
}

/**
 * A URL path to serve under, as "/a/b/": "test/path", "/test/path", "/test/path/" and "https://host/test/path" all
 * work. Git Bash turns an argument like /test/path into C:/Program Files/Git/test/path before we see it: that is
 * refused with how to avoid it, since it would silently serve everything under the wrong path.
 */
export function normaliseBase(raw: string, from = 'command line'): string {
  let b = raw.trim().replace(/\\/g, '/');
  if (/^https?:\/\//i.test(b)) b = new URL(b).pathname;
  if (/^[a-z]:\//i.test(b))
    throw new ConfigError(
      `base looks like a Windows path (${raw}, from ${from}). Git Bash rewrites arguments that start with "/": write it without the leading slash (--base test/path) or set MSYS_NO_PATHCONV=1.`,
    );
  b = '/' + b.split('/').filter(Boolean).join('/') + '/';
  if (b === '//') b = '/';
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(b)) throw new ConfigError(`base can only use URL path characters (got ${raw})`);
  if (b.split('/').some((p) => p === '..' || p === '.')) throw new ConfigError(`base can't contain . or .. (got ${raw})`);
  return b;
}

/** The settings as text, with secrets masked and where each came from. */
export function describe(s: Settings): string {
  const rows = (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).map((k) => {
    let v: unknown = s[k];
    if (k === 'token' && v) v = '••••••';
    const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v === '' ? '(none)' : String(v);
    return `  ${k.padEnd(12)} ${shown.padEnd(36)} ${s.sources[k] ?? 'default'}`;
  });
  return ['folderview settings:', ...rows].join('\n');
}
