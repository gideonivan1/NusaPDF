/**
 * Scans everything git would commit for real secret values and key-shaped
 * strings, and refuses to pass if any turn up.
 *
 * Written as a script rather than typed inline each time because the throwaway
 * version had a bug: `\s*` after `=` matched across newlines, so a variable with
 * an empty value swallowed the *next line's name* and reported it as a secret.
 * That produced false alarms on `.env.example` — harmless, but a scanner nobody
 * trusts is a scanner nobody runs.
 *
 * Run: npm run scan:secrets
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Values that are secret but expected to appear in tracked files. */
const ALLOWED_IN = new Map([
  // The publishable key is designed to ship to the browser; RLS is the control.
  // It still must not be committed, so nothing is exempted here today.
]);

function loadSecrets() {
  let env;
  try {
    env = readFileSync('.env.local', 'utf8');
  } catch {
    return [];
  }

  const secrets = [];

  for (const line of env.split(/\r?\n/)) {
    // Anchored per line, and the value may not contain a line break — this is
    // the fix for the bug described above.
    const match = line.match(/^[ \t]*([A-Z0-9_]+)[ \t]*=[ \t]*([^\r\n]+)[ \t]*$/);
    if (!match) continue;

    const [, name, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');

    // Short values are words, not credentials, and would match everywhere.
    if (value.length < 16) continue;
    secrets.push({ name, value });
  }

  return secrets;
}

const PATTERNS = [
  ['JWT', /eyJhbGciOi[A-Za-z0-9_\-]{10,}/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_\-]{10,}/],
  ['Supabase publishable key', /sb_publishable_[A-Za-z0-9_\-]{10,}/],
  ['Google API key', /AIza[A-Za-z0-9_\-]{30,}/],
  ['Gemini key', /\bAQ\.[A-Za-z0-9_\-]{20,}/],
  ['Supabase project URL', /https:\/\/[a-z]{20}\.supabase\.co/],
];

function trackedFiles() {
  // Staged files if anything is staged, otherwise everything git would add.
  const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  if (staged.length > 0) return { files: staged, scope: 'ter-stage' };

  const all = execSync('git add -An --dry-run .', { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.replace(/^add /, '').replace(/^'|'$/g, '').trim())
    .filter(Boolean);
  return { files: all, scope: 'akan ditambahkan' };
}

const secrets = loadSecrets();
const { files, scope } = trackedFiles();

console.log(`\nPemindaian rahasia — ${files.length} berkas (${scope})`);
console.log(
  secrets.length > 0
    ? `Nilai dari .env.local yang dicari: ${secrets.map((s) => s.name).join(', ')}\n`
    : 'Tidak ada .env.local; hanya pemindaian pola.\n',
);

let findings = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable
  }

  for (const secret of secrets) {
    if (!text.includes(secret.value)) continue;
    if (ALLOWED_IN.get(secret.name)?.includes(file)) continue;
    console.log(`  BOCOR   ${file}  ← nilai ${secret.name}`);
    findings++;
  }

  for (const [label, pattern] of PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    console.log(`  CURIGA  ${file}  ← ${label}: ${match[0].slice(0, 16)}…`);
    findings++;
  }
}

console.log(
  findings === 0
    ? 'BERSIH — tidak ada nilai rahasia maupun pola kunci.\n'
    : `\n${findings} temuan. JANGAN push sebelum ditangani.\n`,
);

process.exit(findings === 0 ? 0 : 1);
