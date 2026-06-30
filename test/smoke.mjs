#!/usr/bin/env node
/**
 * Smoke test — runs the tool against examples/demo-app and asserts the graph it
 * produces matches the known-good fixture. Wired into `prepublishOnly`, so a
 * broken build can never be published.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
console.log('smoke: component-graph on examples/demo-app');

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

// ---- nav-audit + the --nav-json pipeline ----
console.log('smoke: nav-audit on examples/demo-app');
const audit = spawnSync('node', ['nav-audit.mjs', 'examples/demo-app', '--json', 'test/.smoke-orphans.json'], { cwd: root, encoding: 'utf8' });
ok(audit.status === 1, 'nav-audit exits 1 when an orphan route exists');
let orphansJson = {};
try { orphansJson = JSON.parse(readFileSync(join(root, 'test/.smoke-orphans.json'), 'utf8')); } catch { /* asserted below */ }
rmSync(join(root, 'test/.smoke-orphans.json'), { force: true });
ok(orphansJson?.summary?.orphans === 1, 'finds exactly 1 orphan route');
ok(orphansJson?.orphans?.[0]?.path === '/settings', 'the orphan route is /settings');
ok(orphansJson?.summary?.orphanComponents === 0, 'no fully-unused orphan components');

// component-graph consumes nav-audit's JSON and paints the orphan red
const piped = spawnSync('node', ['component-graph.mjs', 'examples/demo-app', '--dot', 'test/.smoke.dot', '--nav-json', 'examples/orphan-routes.json'], { cwd: root, encoding: 'utf8' });
const pipedDot = (() => { try { const d = readFileSync(join(root, 'test/.smoke.dot'), 'utf8'); rmSync(join(root, 'test/.smoke.dot'), { force: true }); return d; } catch { return ''; } })();
ok(piped.status === 0, 'component-graph accepts --nav-json');
ok(/orphan route/.test(pipedDot), '--nav-json marks the orphan route red');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall smoke assertions passed');
