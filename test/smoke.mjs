#!/usr/bin/env node
/**
 * Smoke test — runs the tool against examples/demo-app and asserts the graph
 * it produces matches the known-good fixture. Wired into `prepublishOnly`, so a
 * broken build can never be published.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(tmpdir(), `ng-component-graph-smoke-${process.pid}.json`);

let failed = 0;
const eq = (actual, expected, msg) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
};

execFileSync('node', ['component-graph.mjs', 'examples/demo-app', '--json', out], { cwd: root, stdio: 'pipe' });
const r = JSON.parse(readFileSync(out, 'utf8'));
rmSync(out, { force: true });

console.log('smoke: examples/demo-app');
eq(r.summary.components, 9, 'parses 9 components');
eq(r.summary.edges, 4, 'finds 4 composition edges');
eq(r.summary.isolatedPages, 2, 'recognises 2 isolated route pages / roots');
eq(r.summary.isolatedDialogs, 1, 'recognises 1 dialog.open() component');
eq(r.summary.isolatedOther, 1, 'flags exactly 1 suspect');
eq(r.isolatedOther.map(c => c.className), ['LegacyBannerComponent'], 'the suspect is LegacyBannerComponent');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall smoke assertions passed');
