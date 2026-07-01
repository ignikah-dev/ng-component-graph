#!/usr/bin/env node
/**
 * ng-component-graph
 * --------------------------------------------------------------------------
 * Draw the full hierarchy of a standalone Angular app:
 *   app (bootstrap) → route (URL path) → page component → child component → child…
 *
 * It reconstructs the real URL path tree from `*.routes.ts` (inline `children`,
 * lazy `loadChildren`, `loadComponent`, `component:`, `redirectTo`, `data.title`),
 * connects each route to its page component, then expands each page via its
 * standalone `@Component({ imports: [...] })` array into the child components it
 * composes — all parsed with the TypeScript AST (not regex), so the edges match
 * what a template can actually use.
 *
 * It automatically marks:
 *   - shell routes    — a `component:` whose name contains "Layout" (blue).
 *   - dual-role pages  — a component that is BOTH a route target AND someone
 *                        else's imports[] child, i.e. a page embedded in a page
 *                        (amber).
 *   - external/unresolved lazy children — a `loadChildren` whose route export
 *                        can't be found in this app (dashed grey).
 *   - empty / never-loaded route exports — exported `Routes` arrays that nothing
 *                        ever `loadChildren`s (reported on stderr). Route exports that
 *                        live in a shared lib (extra root / monorepo `libs/`) are
 *                        excluded — a shared lib's routes may be loaded by another app.
 *   - orphan routes    — optional: pass --nav-json to colour routes/pages that
 *                        have no inbound navigation red (see README for shape).
 *
 * Usage:
 *   node component-graph.mjs <app-dir> [--png out.png] [--svg out.svg] [--dot out.dot]
 *                                      [--html out.html] [--nav-json orphans.json]
 *                                      [--libs libs/ | libs/a,libs/b]
 *   (--svg/--png require graphviz: `brew install graphviz` / `apt install graphviz`)
 *
 * DEFAULT: with no format flag, a self-contained, dependency-free HTML page is
 * written to `<app>.component-graph.html` — the same hierarchy as an indented,
 * collapsible tree with a live search box (no graphviz needed). Pass --html to
 * choose the path, or --dot/--svg/--png for the graphviz formats instead.
 * --libs adds extra roots (e.g. a monorepo's `libs/`) to the component scan so
 * `imports: [...]` edges resolve into shared libraries; if omitted, a sibling
 * `libs/` folder is auto-detected by walking up from the app dir (always on).
 *
 * A one-line summary is always written to stderr. Use `--dot -` to stream the
 * graphviz DOT source to stdout (e.g. `… --dot - | dot -Tsvg > graph.svg`).
 *
 * License: MIT
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const input = pos[0];
if (!input) { console.error('Usage: node component-graph.mjs <app-dir> [--html out.html] [--png out] [--svg out] [--dot out] [--nav-json orphans.json] [--libs dir1,dir2]\n(no format flag → writes <app>.component-graph.html; libs/ is auto-detected)'); process.exit(2); }
const pngOut = flag('--png'), svgOut = flag('--svg'), dotOut = flag('--dot');
const hasHtmlFlag = argv.includes('--html');
let htmlOut = flag('--html'); if (htmlOut && htmlOut.startsWith('--')) htmlOut = null; // '--html' with no path → default filename
const navJson = flag('--nav-json');   // optional: JSON listing orphan routes → colour them red
const libsFlag = flag('--libs');      // optional: comma-separated extra roots to scan for components (monorepo libs/)

// Orphan routes (defined but nothing navigates to them). Shape:
//   { "orphans": [ { "path": "/settings", "component": "SettingsPageComponent" }, ... ] }
const orphanPaths = new Set(), orphanComps = new Set();
if (navJson && existsSync(resolve(process.cwd(), navJson))) {
  try {
    const nav = JSON.parse(readFileSync(resolve(process.cwd(), navJson), 'utf8'));
    for (const o of nav.orphans || []) { if (o.path) orphanPaths.add(o.path.startsWith('/') ? o.path : '/' + o.path); if (o.component) orphanComps.add(o.component); }
  } catch (e) { console.error('Failed to read --nav-json: ' + e.message); }
}

let srcDir = resolve(process.cwd(), input);
if (existsSync(join(srcDir, 'src', 'app'))) srcDir = join(srcDir, 'src', 'app');
else if (existsSync(join(srcDir, 'app'))) srcDir = join(srcDir, 'app');
if (!existsSync(srcDir)) { console.error(`Source directory not found: ${srcDir}`); process.exit(2); }
const appName = input.replace(/\/+$/, '').split('/').filter(Boolean).pop();

// ---------- extra component roots (monorepo libs/) ----------
// Components in a standalone app are often published from sibling libraries (Nx `libs/`,
// or any shared folder). Scan those too so `imports: [...]` edges resolve into them.
const extraRoots = [];
if (libsFlag) {
  for (const p of libsFlag.split(',')) { const rp = resolve(process.cwd(), p.trim()); if (existsSync(rp)) extraRoots.push(rp); else console.error(`--libs path not found (skipped): ${rp}`); }
} else {
  // auto-detect: walk up from the app dir looking for a sibling `libs/` folder
  let dir = srcDir;
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'libs');
    if (existsSync(cand) && !srcDir.startsWith(cand)) { extraRoots.push(cand); break; }
    const parent = resolve(dir, '..');
    if (parent === dir) break; dir = parent;
  }
}

// ---------- walk ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'api') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}
const seenFiles = new Set();
const allFiles = [];
for (const root of [srcDir, ...extraRoots]) for (const f of walk(root)) if (!seenFiles.has(f)) { seenFiles.add(f); allFiles.push(f); }
if (extraRoots.length) console.error(`scanning extra roots for components: ${extraRoots.join(', ')}`);
const routeFiles = allFiles.filter((f) => /\.routes\.ts$/.test(f));
const componentFiles = allFiles.filter((f) => /\.component\.ts$/.test(f) && !/\.spec\.ts$/.test(f));

// ---------- parse component imports[] (page → child edges) ----------
function parseComponent(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let info = null;
  (function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const deco = ts.getDecorators?.(node)?.find((d) => ts.isCallExpression(d.expression) && d.expression.expression.getText(sf) === 'Component');
      if (deco) {
        const arg = deco.expression.arguments[0];
        let selector = null; const imports = [];
        if (arg && ts.isObjectLiteralExpression(arg)) for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = p.name.getText(sf);
          if (key === 'selector' && ts.isStringLiteral(p.initializer)) selector = p.initializer.text;
          if (key === 'imports' && ts.isArrayLiteralExpression(p.initializer)) for (const el of p.initializer.elements) imports.push(el.getText(sf).trim());
        }
        info = { className: node.name.getText(sf), selector, imports, file };
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return info;
}
const components = componentFiles.map(parseComponent).filter(Boolean);
const byClass = new Map(components.map((c) => [c.className, c]));
const childEdges = new Map(); // class -> [childClass]
for (const c of components) {
  const kids = [];
  for (const imp of c.imports) {
    const id = (imp.match(/[A-Za-z_$][A-Za-z0-9_$]*/) || [])[0];
    if (id && byClass.has(id) && id !== c.className) kids.push(id);
  }
  if (kids.length) childEdges.set(c.className, kids);
}

// ---------- parse *.routes.ts into export -> route objects ----------
function parseRouteObj(node, sf) {
  const o = { path: null, component: null, loadComp: null, loadChildrenExport: null, children: [], redirect: false, title: null };
  if (!ts.isObjectLiteralExpression(node)) return o;
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name.getText(sf);
    const txt = p.initializer.getText(sf);
    if (key === 'path' && ts.isStringLiteral(p.initializer)) o.path = p.initializer.text;
    else if (key === 'redirectTo') o.redirect = true;
    else if (key === 'component') o.component = txt.trim();
    else if (key === 'loadComponent') { const m = txt.match(/m\.([A-Za-z_$][A-Za-z0-9_$]*)/); o.loadComp = m ? m[1] : null; }
    else if (key === 'loadChildren') { const m = txt.match(/m\.([A-Za-z_$][A-Za-z0-9_$]*)/); o.loadChildrenExport = m ? m[1] : null; }
    else if (key === 'children' && ts.isArrayLiteralExpression(p.initializer)) o.children = p.initializer.elements.map((e) => parseRouteObj(e, sf));
    else if (key === 'data') { const t = txt.match(/title:\s*['"]([^'"]+)['"]/); if (t) o.title = t[1]; }
  }
  return o;
}
const routeExports = new Map(); // exportName -> { file, routes }
for (const f of routeFiles) {
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  (function visit(node) {
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) {
        if (d.name && ts.isIdentifier(d.name) && d.initializer && ts.isArrayLiteralExpression(d.initializer)) {
          routeExports.set(d.name.getText(sf), { file: f, routes: d.initializer.elements.map((e) => parseRouteObj(e, sf)) });
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
}

// ---------- build route tree from the app's root routes ----------
const joinPath = (a, b) => { if (!b) return a || '/'; const seg = b.replace(/^\//, ''); return (a === '/' || a === '') ? '/' + seg : a + '/' + seg; };
const routeNodes = []; // { id, path, comp, kind:'page'|'shell'|'external'|'redirect'|'root', title }
const routeTreeEdges = []; // [parentId, childId]
const route2page = []; // [routeId, compClass]
let rid = 0;
const emptyChildExports = new Set([...routeExports.keys()]); // will delete the ones referenced

function walkRoutes(list, parentPath, parentId) {
  for (const r of list) {
    if (r.redirect) continue;
    const full = joinPath(parentPath, r.path);
    const id = 'r' + rid++;
    let kind = 'page', comp = r.component || r.loadComp || null, title = r.title;
    if (r.component && /Layout/.test(r.component)) kind = 'shell';
    routeNodes.push({ id, path: full, comp, kind, title });
    if (parentId) routeTreeEdges.push([parentId, id]);
    if (comp) route2page.push([id, comp]);
    // inline children
    if (r.children?.length) walkRoutes(r.children, full, id);
    // lazy children via loadChildren
    if (r.loadChildrenExport) {
      emptyChildExports.delete(r.loadChildrenExport);
      const target = routeExports.get(r.loadChildrenExport);
      if (target) walkRoutes(target.routes, full, id);
      else { const exId = 'r' + rid++; routeNodes.push({ id: exId, path: full + '  (external/unresolved: ' + r.loadChildrenExport + ')', kind: 'external' }); routeTreeEdges.push([id, exId]); }
    }
  }
}
const app = routeExports.get('appRoutes') || [...routeExports.values()].find((v) => /app\.routes\.ts$/.test(v.file));
const rootId = 'app';
routeNodes.push({ id: rootId, path: appName + ' (bootstrap)', kind: 'root' });
if (app) walkRoutes(app.routes, '', rootId);

// emptyChildExports now = route exports that are never loadChildren'd (and not the root)
emptyChildExports.delete('appRoutes');
if (app) { for (const [name, v] of routeExports) if (v === app) emptyChildExports.delete(name); }
// route exports living in a shared lib (extra root / monorepo `libs/`) are NOT per-app orphans:
// a shared lib's routes are meant to be reused, and may be loadChildren'd by a *different* app
// than the one being graphed — so scanning them here as an extra root must not flag them.
if (extraRoots.length) for (const [name, v] of routeExports) {
  if (v.file && extraRoots.some((r) => v.file === r || v.file.startsWith(r + '/'))) emptyChildExports.delete(name);
}
const emptyRouteFiles = [...emptyChildExports].map((n) => ({ name: n, file: routeExports.get(n)?.file, count: routeExports.get(n)?.routes.length ?? 0 }));

// ---------- dual-role detection: a route-target component that is ALSO someone's child ----------
const routeTargets = new Set(route2page.map(([, c]) => c));
const allChildren = new Set([...childEdges.values()].flat());
const dualRole = new Set([...routeTargets].filter((c) => allChildren.has(c)));

// ---------- collect page→child→child (recursive) ----------
const compEdges = []; const compEdgeSeen = new Set(); const compNodes = new Set();
function expand(cls, seen = new Set()) {
  if (seen.has(cls)) return; seen.add(cls); compNodes.add(cls);
  for (const k of childEdges.get(cls) || []) {
    const key = cls + '->' + k;
    if (!compEdgeSeen.has(key)) { compEdgeSeen.add(key); compEdges.push([cls, k]); }
    expand(k, seen);
  }
}
for (const c of routeTargets) expand(c);

// ---------- DOT ----------
const lbl = (c) => { const cc = byClass.get(c); return cc ? (cc.selector || c) : c; };
const esc = (s) => String(s).replace(/"/g, '\\"');
function dot() {
  const L = [
    'digraph route_components {',
    '  rankdir=LR;',
    `  graph [fontname="Helvetica", label="${appName} — app → route → page → component", labelloc=t, fontsize=20];`,
    '  node [fontname="Helvetica", fontsize=11];',
    '  edge [color="#888", arrowsize=0.7];',
    '  // --- root ---',
    `  ${rootId} [label="${appName}", shape=doublecircle, style=filled, fillcolor="#ffe08a", color="#b8860b"];`,
    '  // --- route nodes ---',
  ];
  for (const n of routeNodes) {
    if (n.id === rootId) continue;
    const orphan = orphanPaths.has(n.path);
    if (orphan) L.push(`  ${n.id} [label="✗ orphan route\\n${esc(n.path)}${n.title ? '\\n“' + esc(n.title) + '”' : ''}", shape=note, style="filled,bold", fillcolor="#ffd6d6", color="#d62828", penwidth=2];`);
    else if (n.kind === 'shell') L.push(`  ${n.id} [label="${esc(n.path)}\\n(${n.comp})", shape=box, style="filled,rounded", fillcolor="#cfe8ff", color="#1d4ed8"];`);
    else if (n.kind === 'external') L.push(`  ${n.id} [label="${esc(n.path)}", shape=note, style="filled,dashed", fillcolor="#f4f4f4", color="#999"];`);
    else L.push(`  ${n.id} [label="${esc(n.path)}${n.title ? '\\n“' + esc(n.title) + '”' : ''}", shape=note, style=filled, fillcolor="#fff7e6", color="#d39e00"];`);
  }
  L.push('  // --- route tree edges ---');
  for (const [a, b] of routeTreeEdges) L.push(`  ${a} -> ${b} [color="#bbb"];`);
  // --- page + child component nodes ---
  L.push('  // --- page + child component nodes ---');
  for (const c of compNodes) {
    const isPage = routeTargets.has(c);
    const dual = dualRole.has(c);
    const orphan = orphanComps.has(c);
    const fill = orphan ? '#ffd6d6' : dual ? '#ffd6a5' : isPage ? '#d6f5dd' : '#f4f4f4';
    const stroke = orphan ? '#d62828' : dual ? '#d39e00' : isPage ? '#1a7f37' : '#666';
    const extra = orphan ? '\\n✗ orphan-route page' : dual ? '\\n★ route+child' : '';
    L.push(`  C_${c} [label="${esc(lbl(c))}${extra}", shape=box, style="filled,rounded", fillcolor="${fill}", color="${stroke}"];`);
  }
  // --- route -> page edges ---
  L.push('  // --- route -> page component ---');
  for (const [r, c] of route2page) if (compNodes.has(c)) L.push(`  ${r} -> C_${c} [color="#1a7f37", penwidth=1.4];`);
  // --- page -> child edges ---
  L.push('  // --- component composition ---');
  for (const [a, b] of compEdges) L.push(`  C_${a} -> C_${b} [color="#555"];`);
  // --- legend ---
  L.push('  subgraph cluster_legend { label="legend"; fontsize=12; style=dashed; color="#bbb";');
  L.push('    Lr [label="app root", shape=doublecircle, style=filled, fillcolor="#ffe08a", color="#b8860b"];');
  L.push('    Lsh [label="layout shell route", shape=box, style="filled,rounded", fillcolor="#cfe8ff", color="#1d4ed8"];');
  L.push('    Lrt [label="route path", shape=note, style=filled, fillcolor="#fff7e6", color="#d39e00"];');
  L.push('    Lpg [label="page component", shape=box, style="filled,rounded", fillcolor="#d6f5dd", color="#1a7f37"];');
  L.push('    Lch [label="child component", shape=box, style="filled,rounded", fillcolor="#f4f4f4", color="#666"];');
  L.push('    Ldu [label="★ route+child (page-in-page)", shape=box, style="filled,rounded", fillcolor="#ffd6a5", color="#d39e00"];');
  L.push('    Lor [label="✗ orphan route (no inbound nav)", shape=note, style="filled,bold", fillcolor="#ffd6d6", color="#d62828", penwidth=2];');
  L.push('    Lr -> Lsh -> Lrt -> Lpg -> Lch -> Ldu -> Lor [style=invis];');
  L.push('  }');
  L.push('}');
  return L.join('\n');
}

// ---------- HTML: indented, collapsible, searchable tree ----------
// Same model as the DOT graph (app → route tree → page → child…), but rendered as a
// nested tree with a live search box. Components form a DAG, so repeated nodes are shown
// once-expanded and thereafter marked as a reference (↩) to avoid infinite recursion.
function buildHtmlTree() {
  const childrenOf = new Map();
  for (const [a, b] of routeTreeEdges) { if (!childrenOf.has(a)) childrenOf.set(a, []); childrenOf.get(a).push(b); }
  const routeById = new Map(routeNodes.map((n) => [n.id, n]));
  const pageOf = new Map(); for (const [r, c] of route2page) pageOf.set(r, c);

  function compNode(cls, seen) {
    const cc = byClass.get(cls);
    const node = {
      type: 'comp', label: cc?.selector || cls, className: cls,
      role: orphanComps.has(cls) ? 'orphan' : dualRole.has(cls) ? 'dual' : routeTargets.has(cls) ? 'page' : 'child',
      children: [],
    };
    if (seen.has(cls)) { node.ref = true; return node; }
    const seen2 = new Set(seen); seen2.add(cls);
    for (const k of childEdges.get(cls) || []) node.children.push(compNode(k, seen2));
    return node;
  }
  function routeNode(id) {
    const n = routeById.get(id);
    const node = {
      type: n.kind === 'root' ? 'root' : 'route',
      label: n.path, title: n.title || null, comp: n.comp || null,
      role: orphanPaths.has(n.path) ? 'orphan-route' : n.kind, children: [],
    };
    for (const cid of childrenOf.get(id) || []) node.children.push(routeNode(cid));
    const page = pageOf.get(id);
    if (page && byClass.has(page)) node.children.push(compNode(page, new Set()));
    return node;
  }
  return routeNode(rootId);
}

function htmlDoc() {
  const tree = buildHtmlTree();
  // components parsed but never reached from any route page — surfaced as a table,
  // classified by whether they live under a monorepo `libs/` or an `apps/` (or the app itself)
  const referenced = new Set(compNodes);
  const classify = (file) => {
    const norm = file.replace(/\\/g, '/');
    let i = norm.lastIndexOf('/libs/'); if (i >= 0) return { source: 'libs', path: norm.slice(i + 1) };
    i = norm.lastIndexOf('/apps/');    if (i >= 0) return { source: 'apps', path: norm.slice(i + 1) };
    return { source: 'app', path: norm.split('/').slice(-3).join('/') };
  };
  const unused = components
    .filter((c) => !referenced.has(c.className))
    .map((c) => { const { source, path } = classify(c.file); return { className: c.className, selector: c.selector || '', source, path }; })
    .sort((a, b) => (a.source === b.source ? a.path.localeCompare(b.path) : a.source.localeCompare(b.source)));
  const unusedBySource = {}; for (const u of unused) unusedBySource[u.source] = (unusedBySource[u.source] || 0) + 1;
  const data = {
    app: appName,
    summary: { routes: routeNodes.length - 1, pages: routeTargets.size, children: compNodes.size - routeTargets.size, dual: dualRole.size, unused: unused.length, unusedBySource },
    roots: extraRoots,
    tree, unused,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${appName} — component tree</title>
<style>
  :root { --page:#1a7f37; --child:#666; --shell:#1d4ed8; --route:#d39e00; --dual:#d39e00; --orphan:#d62828; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #d0d7de; padding: 12px 20px; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  h1 .sub { font-weight: 400; color: #656d76; font-size: 13px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #q { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
  button { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; font-size: 13px; }
  button:hover { background: #eef1f4; }
  .counts { color: #656d76; font-size: 12px; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: #656d76; }
  .legend span::before { content: "●"; margin-right: 4px; }
  .lg-page::before { color: var(--page); } .lg-child::before { color: var(--child); }
  .lg-route::before { color: var(--route); } .lg-shell::before { color: var(--shell); }
  .lg-dual::before { color: var(--dual); } .lg-orphan::before { color: var(--orphan); }
  main { padding: 16px 20px 60px; }
  ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 20px; }
  ul.tree { padding-left: 0; }
  li { position: relative; }
  .row { display: inline-flex; align-items: baseline; gap: 6px; padding: 2px 4px; border-radius: 5px; }
  .row:hover { background: #eef1f4; }
  .tog { display: inline-block; width: 14px; text-align: center; cursor: pointer; color: #656d76; user-select: none; flex: none; }
  .tog.leaf { visibility: hidden; }
  .name { font-weight: 600; }
  .tag { font-size: 11px; color: #656d76; }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; border: 1px solid currentColor; }
  li.collapsed > ul { display: none; }
  li.hidden { display: none; }
  mark { background: #fff8c5; padding: 0 1px; }
  .role-page > .row .name { color: var(--page); }
  .role-child > .row .name { color: var(--child); }
  .role-dual > .row .name { color: var(--dual); }
  .role-orphan > .row .name, .role-orphan-route > .row .name { color: var(--orphan); }
  .role-shell > .row .name { color: var(--shell); }
  .role-route > .row .name, .role-page-route > .row .name { color: var(--route); }
  .ref { color: #999; font-style: italic; }
  .unused { margin-top: 28px; padding-top: 16px; border-top: 1px solid #d0d7de; }
  .unused h2 { font-size: 14px; margin: 0 0 4px; }
  .unused h2 .counts { font-weight: 400; margin-left: 6px; }
  .unused-tbl { border-collapse: collapse; width: 100%; max-width: 960px; margin-top: 10px; font-size: 13px; }
  .unused-tbl th, .unused-tbl td { text-align: left; padding: 5px 12px 5px 4px; border-bottom: 1px solid #eaecef; vertical-align: top; }
  .unused-tbl th { color: #656d76; font-weight: 600; border-bottom: 2px solid #d0d7de; white-space: nowrap; }
  .unused-tbl code { background: #eef1f4; padding: 1px 5px; border-radius: 4px; }
  .unused-tbl .sel { color: #656d76; }
  .unused-tbl .loc { color: #656d76; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .src { font-size: 10px; padding: 1px 7px; border-radius: 8px; border: 1px solid currentColor; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .src-libs { color: #8250df; } .src-apps { color: #0969da; } .src-app { color: #656d76; }
</style>
</head>
<body>
<header>
  <h1>${appName} <span class="sub">app → route → page → component</span></h1>
  <div class="bar">
    <input id="q" type="search" placeholder="Search routes &amp; components… (name, selector, path)">
    <button id="expand">Expand all</button>
    <button id="collapse">Collapse all</button>
    <span class="counts" id="counts"></span>
  </div>
  <div class="legend">
    <span class="lg-route">route path</span>
    <span class="lg-shell">layout shell</span>
    <span class="lg-page">page component</span>
    <span class="lg-child">child component</span>
    <span class="lg-dual">page-in-page</span>
    <span class="lg-orphan">orphan</span>
  </div>
</header>
<main>
  <ul class="tree" id="tree"></ul>
  <div class="unused" id="unusedBox"></div>
</main>
<script>
const DATA = ${json};
const tree = document.getElementById('tree');

function roleClass(n) {
  if (n.type === 'root') return 'role-root';
  if (n.type === 'route') return n.role === 'orphan-route' ? 'role-orphan-route' : n.role === 'shell' ? 'role-shell' : 'role-route';
  return 'role-' + n.role;
}
function badge(n) {
  if (n.type === 'route' && n.role === 'orphan-route') return '<span class="badge" style="color:var(--orphan)">orphan route</span>';
  if (n.type === 'route' && n.role === 'shell') return '<span class="badge" style="color:var(--shell)">shell</span>';
  if (n.type === 'route' && n.role === 'external') return '<span class="badge" style="color:#999">external</span>';
  if (n.type === 'comp' && n.role === 'dual') return '<span class="badge" style="color:var(--dual)">★ route+child</span>';
  if (n.type === 'comp' && n.role === 'orphan') return '<span class="badge" style="color:var(--orphan)">orphan page</span>';
  if (n.type === 'comp' && n.role === 'page') return '<span class="badge" style="color:var(--page)">page</span>';
  return '';
}
function render(node, parent) {
  const li = document.createElement('li');
  li.className = roleClass(node);
  const hasKids = node.children && node.children.length;
  const row = document.createElement('div');
  row.className = 'row';
  const tog = document.createElement('span');
  tog.className = 'tog' + (hasKids ? '' : ' leaf');
  tog.textContent = hasKids ? '▾' : '•';
  row.appendChild(tog);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.label;
  row.appendChild(name);
  // searchable text stored on the li
  let hay = node.label;
  if (node.type === 'comp') { hay += ' ' + node.className; if (node.className !== node.label) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = node.className; row.appendChild(t); } }
  if (node.title) { hay += ' ' + node.title; const t = document.createElement('span'); t.className = 'tag'; t.textContent = '“' + node.title + '”'; row.appendChild(t); }
  if (node.type === 'route' && node.comp) hay += ' ' + node.comp;
  const b = badge(node); if (b) { const s = document.createElement('span'); s.innerHTML = b; row.appendChild(s.firstChild); }
  if (node.ref) { const r = document.createElement('span'); r.className = 'ref'; r.textContent = '↩ ref'; row.appendChild(r); }
  li.dataset.hay = hay.toLowerCase();
  li.appendChild(row);
  if (hasKids) {
    tog.addEventListener('click', () => li.classList.toggle('collapsed'));
    const ul = document.createElement('ul');
    for (const c of node.children) render(c, ul);
    li.appendChild(ul);
  }
  parent.appendChild(li);
  return li;
}
render(DATA.tree, tree);

// unused components — table split by libs / apps source
if (DATA.unused.length) {
  const bs = DATA.summary.unusedBySource || {};
  const counts = Object.keys(bs).sort().map(s => s + ': ' + bs[s]).join(' · ');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const rows = DATA.unused.map(u => {
    const hay = (u.className + ' ' + u.selector + ' ' + u.path).toLowerCase();
    return '<tr data-hay="' + esc(hay) + '">' +
      '<td><code>' + esc(u.className) + '</code></td>' +
      '<td class="sel">' + (u.selector ? esc(u.selector) : '—') + '</td>' +
      '<td><span class="src src-' + u.source + '">' + u.source + '</span></td>' +
      '<td class="loc">' + esc(u.path) + '</td></tr>';
  }).join('');
  document.getElementById('unusedBox').innerHTML =
    '<h2>Parsed but never referenced by a route page (' + DATA.unused.length + ')' +
    '<span class="counts tag">' + counts + '</span></h2>' +
    '<table class="unused-tbl"><thead><tr><th>Component</th><th>Selector</th><th>Source</th><th>Location</th></tr></thead>' +
    '<tbody id="unusedRows">' + rows + '</tbody></table>';
}

// counts
const s = DATA.summary;
document.getElementById('counts').textContent =
  s.routes + ' routes · ' + s.pages + ' pages · ' + s.children + ' children' +
  (s.dual ? ' · ' + s.dual + ' page-in-page' : '') + (s.unused ? ' · ' + s.unused + ' unused' : '') +
  (DATA.roots.length ? ' · +' + DATA.roots.length + ' extra root(s)' : '');

// search
const q = document.getElementById('q');
function clearMarks(li) { const n = li.querySelector(':scope > .row .name'); if (n && n.dataset.orig !== undefined) { n.textContent = n.dataset.orig; delete n.dataset.orig; } }
function mark(li, term) {
  const n = li.querySelector(':scope > .row .name');
  if (!n) return;
  if (n.dataset.orig === undefined) n.dataset.orig = n.textContent;
  const txt = n.dataset.orig, i = txt.toLowerCase().indexOf(term);
  if (i >= 0) n.innerHTML = txt.slice(0, i) + '<mark>' + txt.slice(i, i + term.length) + '</mark>' + txt.slice(i + term.length);
  else n.textContent = txt;
}
function filterTable(term) {
  document.querySelectorAll('#unusedRows tr').forEach(tr => { tr.style.display = (!term || tr.dataset.hay.includes(term)) ? '' : 'none'; });
}
function filter(term) {
  term = term.trim().toLowerCase();
  filterTable(term);
  const all = tree.querySelectorAll('li');
  if (!term) { all.forEach(li => { li.classList.remove('hidden'); clearMarks(li); }); return; }
  // a li is visible if it matches or any descendant matches; ancestors of a match are shown + expanded
  const matches = new Set();
  all.forEach(li => { if (li.dataset.hay.includes(term)) matches.add(li); });
  all.forEach(li => {
    const self = li.dataset.hay.includes(term);
    const descMatch = self || li.querySelector('li') && [...li.querySelectorAll('li')].some(d => matches.has(d));
    if (descMatch) { li.classList.remove('hidden', 'collapsed'); } else { li.classList.add('hidden'); }
    if (self) mark(li, term); else clearMarks(li);
  });
}
q.addEventListener('input', () => filter(q.value));

document.getElementById('expand').addEventListener('click', () => tree.querySelectorAll('li').forEach(li => li.classList.remove('collapsed')));
document.getElementById('collapse').addEventListener('click', () => tree.querySelectorAll('li').forEach(li => { if (li.querySelector(':scope > ul')) li.classList.add('collapsed'); }));
</script>
</body>
</html>
`;
}

const dotSrc = dot();
// Default output is the self-contained HTML tree — write it whenever no explicit format
// flag is given (or when --html is passed). A default filename is used if --html has no path.
const wantHtml = hasHtmlFlag || (!dotOut && !svgOut && !pngOut);
const htmlTarget = wantHtml ? resolve(process.cwd(), htmlOut || `${appName}.component-graph.html`) : null;
if (htmlTarget) { writeFileSync(htmlTarget, htmlDoc()); console.log('HTML written: ' + htmlTarget); }
if (dotOut) { writeFileSync(resolve(process.cwd(), dotOut === '-' ? '/dev/stdout' : dotOut), dotSrc); if (dotOut !== '-') console.log('DOT written: ' + dotOut); }
function render(fmt, out) { try { execFileSync('dot', ['-T' + fmt, '-o', resolve(process.cwd(), out)], { input: dotSrc }); console.log(`${fmt.toUpperCase()} written: ${out}`); } catch (e) { console.error(`Failed to render ${fmt} (is graphviz installed?): ${e.message}`); process.exitCode = 1; } }
if (svgOut) render('svg', svgOut);
if (pngOut) render('png', pngOut);

console.error(`app=${appName}  routes=${routeNodes.length - 1}  page-comps=${routeTargets.size}  child-comps=${compNodes.size - routeTargets.size}  dual-role=${dualRole.size}`);
if (dualRole.size) console.error('dual-role (route page also embedded as a child): ' + [...dualRole].join(', '));
if (emptyRouteFiles.length) console.error('route exports never loaded via loadChildren: ' + emptyRouteFiles.map((e) => `${e.name}(${e.count})`).join(', '));
