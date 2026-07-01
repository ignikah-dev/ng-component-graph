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
// default output is now HTML; `--dot -` streams the DOT source to stdout for these assertions
const run = spawnSync('node', ['component-graph.mjs', 'examples/demo-app', '--dot', '-'], { cwd: root, encoding: 'utf8' });

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
ok(/digraph route_components/.test(dot), 'emits graphviz DOT to stdout with --dot -');
ok(/label="\/dashboard"/.test(dot), 'route path /dashboard present');
ok(/C_DashboardPageComponent -> C_StatCardComponent/.test(dot), 'page→child edge present');
ok(/COMPOSITION/.test(summary) === false, 'demo-app has no leftover empty routes');

// ---- default output is HTML ----
console.log('smoke: component-graph default output (no flag) on examples/demo-app');
const defRun = spawnSync('node', ['component-graph.mjs', 'examples/demo-app'], { cwd: root, encoding: 'utf8' });
ok(defRun.status === 0, 'runs with no format flag');
ok(/HTML written:.*demo-app\.component-graph\.html/.test(defRun.stdout), 'defaults to writing <app>.component-graph.html');
ok(!/digraph/.test(defRun.stdout), 'no DOT is emitted to stdout by default');
rmSync(join(root, 'demo-app.component-graph.html'), { force: true });

// ---- --html output ----
console.log('smoke: component-graph --html on examples/demo-app');
const htmlRun = spawnSync('node', ['component-graph.mjs', 'examples/demo-app', '--html', 'test/.smoke.html'], { cwd: root, encoding: 'utf8' });
const html = (() => { try { const h = readFileSync(join(root, 'test/.smoke.html'), 'utf8'); rmSync(join(root, 'test/.smoke.html'), { force: true }); return h; } catch { return ''; } })();
ok(htmlRun.status === 0, 'component-graph accepts --html');
ok(/<input id="q"/.test(html), '--html emits a search box');
ok(/const DATA = \{/.test(html), '--html embeds the tree data');
ok(/DashboardPageComponent/.test(html) && /app-stat-card/.test(html), '--html tree includes pages and child selectors');

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

// ---- nav-audit resolves `component: X` through tsconfig aliases + barrel re-exports ----
// fixture: a fallback `component: HomePageComponent` imported via `@app/pages/home`
// (a path alias) that re-exports from an index.ts barrel — must land on the real
// component file, not the barrel, so the page is not mis-flagged as unrouted.
console.log('smoke: nav-audit alias + barrel resolution on test/fixtures/alias-app');
const aliasAudit = spawnSync('node', ['nav-audit.mjs', 'test/fixtures/alias-app', '--json', 'test/.smoke-alias.json'], { cwd: root, encoding: 'utf8' });
let aliasJson = {};
try { aliasJson = JSON.parse(readFileSync(join(root, 'test/.smoke-alias.json'), 'utf8')); } catch { /* asserted below */ }
rmSync(join(root, 'test/.smoke-alias.json'), { force: true });
ok(aliasAudit.status === 0, 'alias-app has no orphan routes (both pages reachable)');
ok(aliasJson?.summary?.notRoutedPages === 0, 'barrel/alias `component: X` counts the page as routed');
ok(aliasJson?.summary?.orphanComponents === 0, 'barrel/alias fallback page is not flagged as dead code');
const homeEntry = (aliasJson?.reachable || []).find(r => r.component === 'HomePageComponent');
ok(!!homeEntry, 'the alias+barrel fallback page (HomePageComponent) is reachable');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall smoke assertions passed');
