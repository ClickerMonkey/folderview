#!/usr/bin/env node
// codeview [folder] [options]: browse, search and review a folder in the browser.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ConfigError, HELP, describe, resolve } from './config.js';
import { start } from './server.js';

function fail(msg: string): never {
  console.error(`codeview: ${msg}`);
  process.exit(1);
}

let parsed;
try {
  parsed = resolve(process.argv.slice(2));
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

const running = await start(s).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
const suffix = s.base + (s.token ? `?token=${encodeURIComponent(s.token)}` : '');
const everywhere = s.host === '0.0.0.0' || s.host === '::';
const hostShown = everywhere || s.host === '127.0.0.1' || s.host === '::1' ? 'localhost' : s.host;
console.log(`codeview ${s.root}`);
console.log(`  http://${hostShown}:${running.port}${suffix}`);
if (everywhere) for (const ip of lanAddresses()) console.log(`  http://${ip}:${running.port}${suffix}`);
else if (s.host === '127.0.0.1') console.log('  (add --lan to open it from other devices)');
if (s.exclude.length) console.log(`  excluding: ${s.exclude.join(', ')}`);
console.log(`  comments: ${path.join(path.resolve(s.root, s.reviewDir), 'REVIEW.md')}`);
if (s.open) openBrowser(`http://localhost:${running.port}${suffix}`);

const stop = () => {
  void running.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
