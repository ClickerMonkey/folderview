#!/usr/bin/env node
// folderview [folder] [options]: browse, search and review a folder in the browser.
// folderview review [folder] [--all] [--json]: print the review comments left in it (for you, or for an agent).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ConfigError, HELP, describe, resolve } from './config.js';
import { start } from './server.js';
import { Review, agentPrompt, toMarkdown } from './review.js';

function fail(msg: string): never {
  console.error(`folderview: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const reviewCommand = argv[0] === 'review';
const all = reviewCommand && argv.includes('--all');
const asJson = reviewCommand && argv.includes('--json');
const args = reviewCommand ? argv.slice(1).filter((a) => a !== '--all' && a !== '--json') : argv;

let parsed;
try {
  parsed = resolve(args);
} catch (e) {
  fail(e instanceof ConfigError ? e.message : String(e));
}
if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}
if (parsed.version) {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
const s = parsed.settings;
if (parsed.printConfig) {
  console.log(describe(s));
  console.log(s.configFiles.length ? `  read: ${s.configFiles.join(', ')}` : '  (no config files)');
  process.exit(0);
}

const rel = (p: string) => {
  const r = path.relative(s.root, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
};
const reviewDir = path.resolve(s.root, s.reviewDir);
const mdRel = rel(path.join(reviewDir, 'REVIEW.md'));
const jsonRel = rel(path.join(reviewDir, 'comments.json'));

// `folderview review`: the comments, as an agent should read them, and nothing else
if (reviewCommand) {
  const comments = new Review(reviewDir, s.root).all();
  const shown = all ? comments : comments.filter((c) => c.status === 'open');
  if (asJson) console.log(JSON.stringify({ comments: shown, file: jsonRel, instructions: agentPrompt(mdRel, jsonRel) }, null, 2));
  else if (!shown.length) console.log(comments.length ? `No open review comments (${comments.length} resolved, in ${jsonRel}).` : 'No review comments yet.');
  else console.log(toMarkdown(shown, jsonRel, { openOnly: !all }));
  process.exit(0);
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.replace(/&/g, '^&')] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
}

let lastOpen = -1;
const running = await start({
  ...s,
  // while it runs, say when there's feedback to read: whoever (or whatever) started it sees it here
  onReviewChange: (open, total) => {
    if (open === lastOpen) return;
    lastOpen = open;
    const time = new Date().toLocaleTimeString();
    if (open) console.log(`[${time}] review: ${open} open comment${open === 1 ? '' : 's'} (of ${total}) → ${mdRel}  (or run: npx folderview review)`);
    else console.log(`[${time}] review: no open comments (${total} resolved)`);
  },
}).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
const suffix = s.base + (s.token ? `?token=${encodeURIComponent(s.token)}` : '');
const everywhere = s.host === '0.0.0.0' || s.host === '::';
const hostShown = everywhere || s.host === '127.0.0.1' || s.host === '::1' ? 'localhost' : s.host;
console.log(`folderview ${s.root}`);
console.log(`  http://${hostShown}:${running.port}${suffix}`);
if (everywhere) for (const ip of lanAddresses()) console.log(`  http://${ip}:${running.port}${suffix}`);
else if (s.host === '127.0.0.1') console.log('  (add --lan to open it from other devices)');
if (s.exclude.length) console.log(`  excluding: ${s.exclude.join(', ')}`);
console.log('  Every option and command: npx folderview --help');
console.log('');
console.log(`  Review feedback is saved to ${mdRel} (and ${jsonRel}).`);
console.log('  For an agent: "' + agentPrompt(mdRel, jsonRel) + '"');
{
  const existing = new Review(reviewDir, s.root).all();
  const open = existing.filter((c) => c.status === 'open').length;
  lastOpen = open;
  if (open) console.log(`  There ${open === 1 ? 'is 1 open comment' : `are ${open} open comments`} waiting: npx folderview review`);
}
if (s.open) openBrowser(`http://localhost:${running.port}${suffix}`);

const stop = () => {
  void running.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
