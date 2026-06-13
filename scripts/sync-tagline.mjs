// Propagates the project tagline from a single source of truth
// (root package.json#description) into:
//   - region-marked Markdown / HTML files (README.md, webview welcome card)
//   - the `description` field of every workspace package.json and the
//     chrome extension manifest
//
// Region-marked files must contain a pair of:
//   <!-- tagline:start -->
//   ...
//   <!-- tagline:end -->
// Only the content inside that region is rewritten; the surrounding
// prose is left alone.
//
// vscode/README.md is intentionally not a region target: it is regenerated
// from the root README.md by `npm run sync:meta` during packaging.
//
// Usage:
//   node scripts/sync-tagline.mjs           # rewrite files in place
//   node scripts/sync-tagline.mjs --check   # exit non-zero if any file would change

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Brand / technology names that should be emphasized in rendered output.
// Order matters: list longer terms first so partial matches do not steal them.
const EMPHASIZE = ['DuckDB-WASM', 'Apache ECharts'];

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const tagline = String(pkg.description ?? '').trim();
if (!tagline) {
  console.error('package.json#description is empty; nothing to sync.');
  process.exit(1);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emphasize(text, wrap) {
  let out = text;
  for (const term of EMPHASIZE) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'g'), wrap(term));
  }
  return out;
}

const markdownTagline = emphasize(tagline, (t) => `**${t}**`);
const htmlTagline = emphasize(escapeHtml(tagline), (t) => `<strong>${t}</strong>`);

// Files with <!-- tagline:start --> / <!-- tagline:end --> region markers.
const regionTargets = [
  {
    file: 'README.md',
    replacement: `<!-- tagline:start -->\n> ${markdownTagline}\n<!-- tagline:end -->`,
  },
  {
    file: 'shared/src/workspace.html',
    replacement: `<!-- tagline:start -->${htmlTagline}<!-- tagline:end -->`,
  },
];

// JSON files whose top-level `description` field is shown to end users
// (Chrome Web Store entry, VS Code Marketplace listing) and must equal the
// raw tagline. Private workspace package.json files (shared, webapp,
// chrome) keep their own role-specific description and are NOT synced.
const jsonTargets = [
  { file: 'vscode/package.json', field: 'description' },
  { file: 'chrome/manifest.json', field: 'description' },
];

const region = /<!-- tagline:start -->[\s\S]*?<!-- tagline:end -->/;
const check = process.argv.includes('--check');

let drift = false;

function commit(file, current, next) {
  if (next === current) {
    console.log(`  ok    ${file}`);
    return;
  }
  if (check) {
    drift = true;
    console.error(`  drift ${file}`);
  } else {
    writeFileSync(resolve(root, file), next);
    console.log(`  wrote ${file}`);
  }
}

for (const { file, replacement } of regionTargets) {
  const path = resolve(root, file);
  const current = readFileSync(path, 'utf8');
  if (!region.test(current)) {
    console.error(`Missing <!-- tagline:start --> / <!-- tagline:end --> markers in ${file}`);
    process.exit(1);
  }
  // Preserve the file's existing line-ending style so syncing does not
  // create noisy LF/CRLF diffs on Windows checkouts.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const next = current.replace(region, replacement.replace(/\n/g, eol));
  commit(file, current, next);
}

for (const { file, field } of jsonTargets) {
  const path = resolve(root, file);
  const current = readFileSync(path, 'utf8');
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = current.endsWith('\n');
  const data = JSON.parse(current);
  if (data[field] === tagline) {
    console.log(`  ok    ${file}`);
    continue;
  }
  data[field] = tagline;
  let next = JSON.stringify(data, null, 2);
  if (eol === '\r\n') next = next.replace(/\n/g, '\r\n');
  if (trailingNewline) next += eol;
  commit(file, current, next);
}

if (check && drift) {
  console.error('\nTagline is out of sync. Run `npm run sync:tagline` to update.');
  process.exit(1);
}
