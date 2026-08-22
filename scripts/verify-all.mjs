/**
 * Runs every verification suite and reports a combined result.
 *
 * Replaces `npm run a && npm run b && npm run c`. That chain depends on the
 * shell npm picks, and in this environment (Git Bash, empty ComSpec) it ran
 * only one suite and still exited 0 — a failing suite could have passed
 * unnoticed, which is worse than having no check at all.
 *
 * Run: npm run verify
 */
import { spawn } from 'node:child_process';

const suites = ['verify:pdf', 'verify:ai', 'verify:office'];

const run = (script) =>
  new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', script], {
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

const results = [];

for (const suite of suites) {
  const code = await run(suite);
  results.push({ suite, code });
}

console.log('\n' + '='.repeat(46));
for (const { suite, code } of results) {
  console.log(`  ${code === 0 ? 'LOLOS' : 'GAGAL'}  ${suite}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(
  failed.length === 0
    ? `\nSeluruh ${suites.length} suite lolos.\n`
    : `\n${failed.length} suite GAGAL.\n`,
);

process.exit(failed.length === 0 ? 0 : 1);
