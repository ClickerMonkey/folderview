// Runs an npm command so its two-factor step is a browser link, not a code: node scripts/npm-web.cjs publish --access public
// npm only offers the web approval (an npmjs.com link you open and approve) when it thinks it's in a terminal, and a
// script or agent isn't one, so npm would ask for an authenticator code instead. This marks stdin/stdout as a terminal
// and runs npm's own CLI with --auth-type=web --browser=false, so it prints the link and waits for the approval.
const path = require('node:path');
const { execSync } = require('node:child_process');

const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
process.stdin.isTTY = true;
process.stdout.isTTY = true;
process.argv = [process.argv[0], path.join(npmRoot, 'npm', 'bin', 'npm-cli.js'), ...process.argv.slice(2), '--auth-type=web', '--browser=false'];
require(path.join(npmRoot, 'npm', 'lib', 'cli.js'))(process);
