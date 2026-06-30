#!/usr/bin/env node
/**
 * Smoke test — runs the tool against examples/demo-app and asserts the graph it
 * produces matches the known-good fixture. Wired into `prepublishOnly`, so a
 * broken build can never be published.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = spawnSync('node', ['component-graph.mjs', 'examples/demo-app'], { cwd: root, encoding: 'utf8' });

let failed = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); } else { console.error(`  ✗ ${msg}`); failed++; } };

if (run.status !== 0) {
  console.error(`tool exited with status ${run.status}\n${run.stderr}`);
  process.exit(1);
}

const dot = run.stdout;
const summary = run.stderr;
console.log('smoke: examples/demo-app');

// stderr summary, e.g. "app=demo-app  routes=3  page-comps=3  child-comps=3  dual-role=0"
const num = (k) => Number((summary.match(new RegExp(`${k}=(\\d+)`)) || [])[1]);
ok(num('routes') === 3, 'reconstructs 3 routes');
ok(num('page-comps') === 3, 'finds 3 page components');
ok(num('child-comps') === 3, 'finds 3 child components');
ok(num('dual-role') === 0, 'no dual-role components');

// DOT shape
ok(/digraph route_components/.test(dot), 'emits graphviz DOT to stdout');
ok(/label="\/dashboard"/.test(dot), 'route path /dashboard present');
ok(/C_DashboardPageComponent -> C_StatCardComponent/.test(dot), 'page→child edge present');
ok(/COMPOSITION/.test(summary) === false, 'demo-app has no leftover empty routes');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall smoke assertions passed');
