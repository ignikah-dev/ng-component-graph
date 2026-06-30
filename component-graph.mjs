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
 *                        ever `loadChildren`s (reported on stderr).
 *   - orphan routes    — optional: pass --nav-json to colour routes/pages that
 *                        have no inbound navigation red (see README for shape).
 *
 * Usage:
 *   node component-graph.mjs <app-dir> [--png out.png] [--svg out.svg] [--dot out.dot]
 *                                      [--nav-json orphans.json]
 *   (--svg/--png require graphviz: `brew install graphviz` / `apt install graphviz`)
 *
 * With no --png/--svg/--dot, the graphviz DOT source is written to stdout and a
 * one-line summary to stderr.
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
if (!input) { console.error('Usage: node component-graph.mjs <app-dir> [--png out] [--svg out] [--dot out] [--nav-json orphans.json]'); process.exit(2); }
const pngOut = flag('--png'), svgOut = flag('--svg'), dotOut = flag('--dot');
const navJson = flag('--nav-json');   // optional: JSON listing orphan routes → colour them red

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

// ---------- walk ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'api') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}
const allFiles = walk(srcDir);
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

const dotSrc = dot();
if (dotOut) { writeFileSync(resolve(process.cwd(), dotOut), dotSrc); console.log('DOT written: ' + dotOut); }
function render(fmt, out) { try { execFileSync('dot', ['-T' + fmt, '-o', resolve(process.cwd(), out)], { input: dotSrc }); console.log(`${fmt.toUpperCase()} written: ${out}`); } catch (e) { console.error(`Failed to render ${fmt} (is graphviz installed?): ${e.message}`); process.exitCode = 1; } }
if (svgOut) render('svg', svgOut);
if (pngOut) render('png', pngOut);
if (!dotOut && !svgOut && !pngOut) console.log(dotSrc); // default: DOT to stdout

console.error(`app=${appName}  routes=${routeNodes.length - 1}  page-comps=${routeTargets.size}  child-comps=${compNodes.size - routeTargets.size}  dual-role=${dualRole.size}`);
if (dualRole.size) console.error('dual-role (route page also embedded as a child): ' + [...dualRole].join(', '));
if (emptyRouteFiles.length) console.error('route exports never loaded via loadChildren: ' + emptyRouteFiles.map((e) => `${e.name}(${e.count})`).join(', '));
