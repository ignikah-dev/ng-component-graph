#!/usr/bin/env node
/**
 * nav-audit.mjs
 * --------------------------------------------------------------------------
 * Companion to component-graph.mjs. Where component-graph maps *structure*,
 * this maps *reachability*: it cross-checks "route → component" against
 * "link/button → route" to find pages that are built and routable but have no
 * navigation pointing at them (orphan routes), plus components that are dead code.
 *
 * Its --json output is the shape component-graph.mjs --nav-json consumes, so the
 * two compose:
 *   node nav-audit.mjs       apps/my-app --json orphans.json
 *   node component-graph.mjs apps/my-app --svg graph.svg --nav-json orphans.json
 *
 * Usage:
 *   node nav-audit.mjs <app-src-or-app-dir> [--md out.md] [--json out.json]
 *
 * How it works:
 *   1. From app.routes.ts, recursively parse *.routes.ts (incl. loadChildren /
 *      loadComponent / component:) into a full route tree (each node carries its
 *      absolute path + the component file it mounts).
 *   2. Scan the whole src for navigation targets:
 *        - templates: routerLink="..." / [routerLink]="[...]"
 *        - TS: router.navigate([...]) / navigateByUrl('...') / createUrlTree([...])
 *        - sidebar/menu data: route: '/...'
 *        - shared layout get*Route() methods returning '/...'
 *   3. Resolve relative targets ('new', ['..', x]) against the source component's
 *      own route, params (:id) and dynamic expressions treated as wildcards.
 *   4. Mark each route reachable + record the entry point (file:line).
 *   5. Report orphan routes + components that exist on disk but are referenced by
 *      nothing (not routed, selector unused, class unreferenced) = dead code.
 *
 * Heuristics you may want to tune for your conventions:
 *   - shell/layout components are excluded from "pages" by name: /Layout$/ or /^Blank/.
 *   - sidebar/menu files are matched by filename containing "sidebar-data" or "menu".
 *   - shared-layout entry methods are matched by name ending in "Route".
 *
 * Note: Angular relative-route resolution (relativeTo + '..') is approximated as
 *       "URL segment ≈ route config level" — correct in the vast majority of cases
 *       but not 100% equivalent to the Angular runtime. This is a review aid that
 *       surfaces suspects for human confirmation, not a hard gate.
 *
 * License: MIT
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
let appArg = null;
let mdOut = null;
let jsonOut = null;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--md') mdOut = rawArgs[++i];
  else if (a === '--json') jsonOut = rawArgs[++i];
  else if (!appArg) appArg = a;
}
if (!appArg) {
  console.error('Usage: node nav-audit.mjs <app-dir|app-src> [--md out.md] [--json out.json]');
  process.exit(2);
}

// accept the app dir or its src dir
let appDir = resolve(process.cwd(), appArg);
let srcDir;
if (existsSync(join(appDir, 'src', 'app'))) srcDir = join(appDir, 'src', 'app');
else if (existsSync(join(appDir, 'app'))) { srcDir = join(appDir, 'app'); appDir = dirname(appDir); }
else if (basename(appDir) === 'app' && existsSync(appDir)) srcDir = appDir;
else if (existsSync(join(appDir, 'src'))) srcDir = join(appDir, 'src');
else srcDir = appDir;

if (!existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`);
  process.exit(2);
}
const appName = basename(appDir);

// ---------------------------------------------------------------------------
// cross-platform recursive file walk (replaces shelling out to `find`)
// ---------------------------------------------------------------------------
function walkDir(dir, exts, cb) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, exts, cb);
    else if (exts.some((e) => ent.name.endsWith(e))) cb(full);
  }
}

// ---------------------------------------------------------------------------
// shared: TS source-file parse cache
// ---------------------------------------------------------------------------
const sfCache = new Map();
function parse(file) {
  if (sfCache.has(file)) return sfCache.get(file);
  if (!existsSync(file)) { sfCache.set(file, null); return null; }
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sfCache.set(file, sf);
  return sf;
}
function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

// resolve an import specifier → absolute .ts file
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // only follow relative imports (within the app)
  let base = resolve(dirname(fromFile), spec);
  const cands = [base + '.ts', join(base, 'index.ts'), base];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// ---------------------------------------------------------------------------
// step 1: parse the route tree
// ---------------------------------------------------------------------------
// within a file, find "name → route-array ArrayLiteral node"
function collectRouteArrays(sf) {
  const map = new Map(); // exportName -> ArrayLiteralExpression
  function visit(node) {
    // export const X = [ ... ]  /  const X: Routes = [ ... ]
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.name && ts.isIdentifier(d.name) && d.initializer && ts.isArrayLiteralExpression(d.initializer)) {
          map.set(d.name.text, d.initializer);
        }
      }
    }
    // RouterModule.forChild([...]) / forRoot([...]) — NgModule style
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'forChild' || callee.name.text === 'forRoot')) {
        const arg = node.arguments[0];
        if (arg && ts.isArrayLiteralExpression(arg)) map.set('__module__' + map.size, arg);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return map;
}

// read a string property off an ObjectLiteral
function strProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name) && p.name.text === name) {
      if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))
        return p.initializer.text;
    }
  }
  return null;
}
function getProp(obj, name) {
  for (const p of obj.properties) {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name && ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return null;
}

// from `() => import('./x').then(m => m.Name)` get { spec, name }
function parseLazyImport(node) {
  let spec = null, name = null;
  function walk(n) {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) spec = a.text;
    }
    // .then(m => m.Name)
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
      if (!name && /^[A-Z]/.test(n.name.text)) name = n.name.text;
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return spec ? { spec, name } : null;
}

let routeNodeId = 0;
const allRouteNodes = []; // flattened nodes

// parse one route array → child nodes; parentSegs is the ancestor segment array
function parseRouteArray(arrayNode, sf, file, parentSegs, importNameMap) {
  for (const el of arrayNode.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const pathProp = getProp(el, 'path');
    let pathVal = strProp(el, 'path');
    if (pathVal == null) {
      if (!pathProp) continue;
      pathVal = '';
    }
    const segs = pathVal === '' ? [] : pathVal.split('/').filter(Boolean);
    const fullSegs = [...parentSegs, ...segs];

    const node = {
      id: routeNodeId++,
      path: pathVal,
      fullPath: '/' + fullSegs.join('/'),
      fullSegs,
      file,
      line: lineOf(sf, el),
      component: null,
      componentFile: null,
      redirectTo: strProp(el, 'redirectTo'),
      pathMatch: strProp(el, 'pathMatch'),
      isLayout: false,
      reachable: false,
      entries: [], // {file,line,kind,raw}
    };

    // component: X (direct reference, resolve the file from imports)
    const compProp = getProp(el, 'component');
    if (compProp && ts.isPropertyAssignment(compProp) && ts.isIdentifier(compProp.initializer)) {
      node.component = compProp.initializer.text;
      const imp = importNameMap.get(node.component);
      if (imp) node.componentFile = imp;
      // layout/shell components are framework, not a "page" (e.g. AppLayoutComponent, Blank…)
      if (/Layout(Component)?$/.test(node.component) || /^Blank/.test(node.component)) node.isLayout = true;
    }

    // loadComponent: () => import().then(m => m.X)
    const lcProp = getProp(el, 'loadComponent');
    if (lcProp && ts.isPropertyAssignment(lcProp)) {
      const lazy = parseLazyImport(lcProp.initializer);
      if (lazy) {
        node.component = lazy.name;
        node.componentFile = resolveImport(file, lazy.spec);
      }
    }

    allRouteNodes.push(node);

    // children: [...]
    const childrenProp = getProp(el, 'children');
    if (childrenProp && ts.isPropertyAssignment(childrenProp) &&
        ts.isArrayLiteralExpression(childrenProp.initializer)) {
      parseRouteArray(childrenProp.initializer, sf, file, fullSegs, importNameMap);
    }

    // loadChildren: () => import('./x').then(m => m.NAME)
    const lchProp = getProp(el, 'loadChildren');
    if (lchProp && ts.isPropertyAssignment(lchProp)) {
      const lazy = parseLazyImport(lchProp.initializer);
      if (lazy) {
        const childFile = resolveImport(file, lazy.spec);
        if (childFile) {
          const childSf = parse(childFile);
          if (childSf) {
            const arrays = collectRouteArrays(childSf);
            const childImports = buildImportNameMap(childSf, childFile);
            let arr = lazy.name && arrays.get(lazy.name);
            if (!arr) arr = [...arrays.values()][0]; // fall back to the first array if no named match
            if (arr) parseRouteArray(arr, childSf, childFile, fullSegs, childImports);
          }
        }
      }
    }
  }
}

// build a file's import-name → resolved-file map (for `component: X` direct references)
function buildImportNameMap(sf, file) {
  const m = new Map();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const resolved = resolveImport(file, stmt.moduleSpecifier.text);
      if (!resolved) continue;
      const nb = stmt.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) m.set(e.name.text, resolved);
      }
    }
  }
  return m;
}

// entry point: app.routes.ts
const appRoutesFile = join(srcDir, 'app.routes.ts');
if (!existsSync(appRoutesFile)) {
  console.error(`Not found: ${appRoutesFile}`);
  process.exit(2);
}
const appSf = parse(appRoutesFile);
const appArrays = collectRouteArrays(appSf);
const appImports = buildImportNameMap(appSf, appRoutesFile);
// take appRoutes (or the first array)
let rootArr = appArrays.get('appRoutes') || appArrays.get('routes') || [...appArrays.values()][0];
parseRouteArray(rootArr, appSf, appRoutesFile, [], appImports);

// ---------------------------------------------------------------------------
// step 2: collect navigation targets
// ---------------------------------------------------------------------------
const navTargets = []; // { segs:[], absolute:bool, relative:bool, file, line, kind, raw, sourceFile }

// normalize a raw routerLink/navigate segment array: expand '/'-containing strings, expr → '*'
function normalizeSegs(rawSegs) {
  const out = [];
  for (const s of rawSegs) {
    if (s == null) { out.push('*'); continue; }
    if (typeof s === 'string') {
      const parts = s.split('/');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === '' && i === 0) { out.push('__ROOT__'); continue; } // leading '/'
        if (p === '') continue;
        out.push(p);
      }
    } else {
      out.push('*');
    }
  }
  return out;
}

// from an ArrayLiteral get raw segments (string literal → text; else → null = dynamic)
function arrayLiteralSegs(arr) {
  return arr.elements.map(e => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return null; // `${...}`
    return null;
  });
}

// ---- 2a. template routerLink (.html + inline template) ----
const linkRe = /\[?routerLink\]?\s*=\s*("([^"]*)"|'([^']*)')/g;
function collectRouterLinksFromText(text, file) {
  let mm;
  const re = new RegExp(linkRe.source, 'g');
  const lines = text.split('\n');
  function lineAt(idx) {
    let c = 0;
    for (let i = 0; i < lines.length; i++) { c += lines[i].length + 1; if (idx < c) return i + 1; }
    return 1;
  }
  while ((mm = re.exec(text))) {
    const isBinding = mm[0].trim().startsWith('[');
    const val = mm[2] != null ? mm[2] : mm[3];
    let rawSegs;
    if (isBinding) {
      // [routerLink]="['a', b, 'c']" or [routerLink]="'/x'"
      const trimmed = val.trim();
      if (trimmed.startsWith('[')) {
        rawSegs = [];
        const inner = trimmed.slice(1, trimmed.lastIndexOf(']'));
        for (const part of splitTopLevel(inner)) {
          const t = part.trim();
          const sm = t.match(/^'([^']*)'$|^"([^"]*)"$/);
          if (sm) rawSegs.push(sm[1] != null ? sm[1] : sm[2]);
          else rawSegs.push(null);
        }
      } else {
        const sm = trimmed.match(/^'([^']*)'$|^"([^"]*)"$/);
        rawSegs = sm ? [sm[1] != null ? sm[1] : sm[2]] : [null];
      }
    } else {
      rawSegs = [val];
    }
    pushNavTarget(rawSegs, file, lineAt(mm.index), 'routerLink', mm[0].slice(0, 80));
  }
}
// split on commas, ignoring commas inside brackets/quotes
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    if (ch === ']' || ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function pushNavTarget(rawSegs, file, line, kind, raw) {
  const norm = normalizeSegs(rawSegs);
  let absolute = false;
  let segs = norm;
  if (norm[0] === '__ROOT__') { absolute = true; segs = norm.slice(1); }
  navTargets.push({ segs, absolute, relative: !absolute, file, line, kind, raw, sourceFile: file });
}

// ---- 2b. TS: router.navigate([...]) / navigateByUrl('...') / routerLink in inline template ----
function collectFromTs(file) {
  const sf = parse(file);
  if (!sf) return;
  const text = sf.text;
  if (/routerLink/.test(text)) collectRouterLinksFromText(text, file);

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      if (m === 'navigate' || m === 'createUrlTree') {
        const arg = node.arguments[0];
        if (arg && ts.isArrayLiteralExpression(arg)) {
          const raw = arrayLiteralSegs(arg);
          pushNavTarget(raw, file, lineOf(sf, node), m, node.getText(sf).slice(0, 90).replace(/\s+/g, ' '));
        }
      } else if (m === 'navigateByUrl') {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          pushNavTarget([arg.text], file, lineOf(sf, node), 'navigateByUrl', node.getText(sf).slice(0, 90).replace(/\s+/g, ' '));
        } else if (arg && ts.isTemplateExpression(arg)) {
          // `${base}/x` — take the head literal
          pushNavTarget([arg.head.text], file, lineOf(sf, node), 'navigateByUrl', '(template) ' + node.getText(sf).slice(0, 70).replace(/\s+/g, ' '));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

// scan .html
walkDir(srcDir, ['.html'], (f) => {
  const text = readFileSync(f, 'utf8');
  if (/routerLink/.test(text)) collectRouterLinksFromText(text, f);
});
// scan .ts (skip generated api/, spec files)
walkDir(srcDir, ['.ts'], (f) => {
  if (f.includes('/api/') || f.includes('\\api\\')) return;
  if (f.endsWith('.spec.ts')) return;
  collectFromTs(f);
});

// ---- 2c. sidebar/menu data: route: '/...' ----
const sidebarRoutes = [];
walkDir(srcDir, ['.ts'], (f) => {
  if (!/sidebar-data|menu/.test(f)) return;
  const sf = parse(f);
  if (!sf) return;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name) &&
        node.name.text === 'route' &&
        (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      const r = node.initializer.text;
      sidebarRoutes.push(r);
      pushNavTarget([r], f, lineOf(sf, node), 'sidebar', `route: '${r}'`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
});

// ---- 2d. shared-layout get*Route() methods returning a route string ----
walkDir(srcDir, ['.ts'], (f) => {
  if (!/[\\/]layout[\\/]/.test(f)) return;
  if (f.endsWith('.spec.ts')) return;
  const sf = parse(f);
  if (!sf) return;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && /Route$/.test(node.name.text)) {
      const inner = (n) => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith('/')) {
          pushNavTarget([n.text], f, lineOf(sf, n), 'layout-route', `${node.name.text}() → '${n.text}'`);
        }
        ts.forEachChild(n, inner);
      };
      if (node.body) inner(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
});

// ---------------------------------------------------------------------------
// step 3: resolve relative navigation targets → absolute segments
// ---------------------------------------------------------------------------
const fileToRoute = new Map();
const dirToRoutes = new Map();
for (const n of allRouteNodes) {
  if (n.componentFile) {
    fileToRoute.set(n.componentFile, n);
    const d = dirname(n.componentFile);
    if (!dirToRoutes.has(d)) dirToRoutes.set(d, []);
    dirToRoutes.get(d).push(n);
  }
}
// find the "owning route" of a source file (.ts/.html): same file or same dir
function ownerRouteOf(sourceFile) {
  if (fileToRoute.has(sourceFile)) return fileToRoute.get(sourceFile);
  let d = dirname(sourceFile);
  for (let i = 0; i < 6; i++) {
    if (dirToRoutes.has(d)) {
      const arr = dirToRoutes.get(d);
      return arr.slice().sort((a, b) => b.fullSegs.length - a.fullSegs.length)[0];
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function resolveTarget(t) {
  if (t.absolute) return t.segs.slice();
  const owner = ownerRouteOf(t.sourceFile);
  const base = owner ? owner.fullSegs.slice() : [];
  const out = base.slice();
  for (const s of t.segs) {
    if (s === '..') out.pop();
    else if (s === '.') continue;
    else out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// step 4: reachability matching
// ---------------------------------------------------------------------------
function segMatch(routeSeg, targetSeg) {
  if (routeSeg.startsWith(':')) return true;   // route param eats any value
  if (targetSeg === '*') return true;          // dynamic target segment
  if (targetSeg === '**') return true;
  return routeSeg === targetSeg;
}
function pathMatches(routeSegs, targetSegs) {
  if (routeSegs.length !== targetSegs.length) return false;
  for (let i = 0; i < routeSegs.length; i++) {
    if (!segMatch(routeSegs[i], targetSegs[i])) return false;
  }
  return true;
}

const resolvedTargets = navTargets.map(t => ({ ...t, abs: resolveTarget(t) }));

for (const n of allRouteNodes) {
  for (const t of resolvedTargets) {
    if (pathMatches(n.fullSegs, t.abs)) {
      n.reachable = true;
      n.entries.push({ file: t.sourceFile, line: t.line, kind: t.kind, raw: t.raw, target: '/' + t.abs.join('/') });
    }
  }
}

// default child / redirect propagation (fixpoint)
let changed = true;
let iter = 0;
while (changed && iter++ < 20) {
  changed = false;
  for (const n of allRouteNodes) {
    if (n.reachable) continue;
    // a) path '' default child: reachable if its parent level is hit by navigation
    if (n.path === '') {
      const parentReachable = allRouteNodes.some(o =>
        o !== n && o.reachable &&
        o.fullSegs.length <= n.fullSegs.length &&
        o.fullSegs.join('/') === n.fullSegs.slice(0, o.fullSegs.length).join('/') &&
        n.fullSegs.length - o.fullSegs.length <= 0
      );
      const sameLevelHit = resolvedTargets.some(t => pathMatches(n.fullSegs, t.abs));
      if (parentReachable || sameLevelHit) { n.reachable = true; changed = true; n.entries.push({ kind: 'default-child', raw: 'default child of a reachable parent' }); continue; }
    }
    // b) redirect target propagation: a reachable node redirectTo points at n
    for (const o of allRouteNodes) {
      if (!o.reachable || !o.redirectTo) continue;
      const rt = o.redirectTo;
      let target;
      if (rt.startsWith('/')) target = rt.split('/').filter(Boolean);
      else target = [...o.fullSegs.slice(0, -1 < 0 ? 0 : o.fullSegs.length - (o.path ? o.path.split('/').filter(Boolean).length : 0)), ...rt.split('/').filter(Boolean)];
      if (pathMatches(n.fullSegs, target)) {
        n.reachable = true; changed = true;
        n.entries.push({ kind: 'redirect', raw: `redirect from ${o.fullPath}` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// step 5: page components on disk vs. referenced by a route
// ---------------------------------------------------------------------------
const pageComponentFiles = [];
if (existsSync(join(srcDir, 'pages'))) {
  walkDir(join(srcDir, 'pages'), ['.component.ts'], (f) => {
    if (f.endsWith('.spec.ts')) return;
    pageComponentFiles.push(f);
  });
}
const routedFiles = new Set(allRouteNodes.filter(n => n.componentFile).map(n => n.componentFile));
const notRoutedPages = pageComponentFiles.filter(f => !routedFiles.has(f));

// detect whether those "non-routed" components are actually opened as dialog/child (imported by any .ts)
const importGraph = new Map(); // file -> Set(imported files)
walkDir(srcDir, ['.ts'], (f) => {
  if (f.endsWith('.spec.ts')) return;
  const sf = parse(f);
  if (!sf) return;
  const set = new Set();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const r = resolveImport(f, stmt.moduleSpecifier.text);
      if (r) set.add(r);
    }
  }
  importGraph.set(f, set);
});
function isImportedAnywhere(target) {
  for (const [f, set] of importGraph) {
    if (f === target) continue;
    if (set.has(target)) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// step 6: whole-app orphan-component analysis (not just pages/)
//   a component counts as "used" if any of:
//     (a) mounted on the route tree
//     (b) its selector appears in any other file's template (.html or inline)
//     (c) its class name is referenced by any other .ts (import / dialog.open / imports:[...])
//   none of the three → orphan component (suspected dead code).
// ---------------------------------------------------------------------------
const allComponentFiles = [];
walkDir(srcDir, ['.component.ts'], (f) => {
  if (f.endsWith('.spec.ts')) return;
  if (f.includes('/api/') || f.includes('\\api\\')) return;
  allComponentFiles.push(f);
});
// exclude example/fixture files (performance-monitor.example.ts, *-example.component.ts…)
const isExample = (f) => /\.example\.ts$|[\\/]examples?[\\/]|-example\.component\.ts$/.test(f);

// preload all text files (.ts + .html)
const textFiles = new Map();
walkDir(srcDir, ['.ts', '.html'], (f) => {
  if (f.endsWith('.spec.ts') || f.includes('/api/') || f.includes('\\api\\')) return;
  try { textFiles.set(f, readFileSync(f, 'utf8')); } catch { /* skip */ }
});
// include the bootstrap entry (main.ts/bootstrap.ts) — the root AppComponent is referenced there
for (const bf of [join(dirname(srcDir), 'main.ts'), join(dirname(srcDir), 'bootstrap.ts'), join(srcDir, 'main.ts')]) {
  if (existsSync(bf) && !textFiles.has(bf)) {
    try { textFiles.set(bf, readFileSync(bf, 'utf8')); } catch { /* skip */ }
  }
}

function extractAllClassNames(text) {
  const re = /export\s+class\s+([A-Za-z0-9_]+)/g; const out = []; let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}
function extractSelector(text) {
  const m = text.match(/selector:\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1].trim() : null;
}

const componentInfo = []; // {file, className, selector, routed, usedInTemplate, refInTs, ...}
for (const f of allComponentFiles) {
  const text = textFiles.get(f) || readFileSync(f, 'utf8');
  const classNames = extractAllClassNames(text);
  const className = classNames[0] || null;
  const selector = extractSelector(text);
  const routed = routedFiles.has(f);
  const ALWAYS_USED = selector === 'app-root'; // bootstrap root

  let usedInTemplate = null;
  let refInTs = null;
  if (selector) {
    const needle = '<' + selector;
    for (const [of, ot] of textFiles) {
      if (of === f) continue;
      if (ot.includes(needle)) { usedInTemplate = of; break; }
    }
  }
  // any class declared in this file referenced by another .ts (import / dialog.open / imports:[...]) → wired
  for (const cn of classNames) {
    const re = new RegExp('\\b' + cn + '\\b');
    for (const [of, ot] of textFiles) {
      if (of === f || !of.endsWith('.ts')) continue;
      if (re.test(ot)) { refInTs = of; break; }
    }
    if (refInTs) break;
  }
  // multi-component file (e.g. a trigger + its dialog companion opened by a sibling's dialog.open) → wired
  const multiClassSelfUse = classNames.length > 1;
  const orphan = !routed && !usedInTemplate && !refInTs && !ALWAYS_USED && !multiClassSelfUse && !isExample(f);
  componentInfo.push({ file: f, className, selector, routed, usedInTemplate, refInTs, orphan, example: isExample(f) });
}
const orphanComponents = componentInfo.filter(c => c.orphan);
// informational only: referenced programmatically (dialog.open / createComponent) but selector not in any
// template and not routed — usually a dialog opened in code, which is normal, so not flagged as a problem.
const dialogLike = componentInfo.filter(c =>
  !c.orphan && !c.routed && !c.usedInTemplate && c.refInTs && c.selector && c.selector !== 'app-root' && !c.example);

// ---------------------------------------------------------------------------
// report output
// ---------------------------------------------------------------------------
const rel = (f) => f ? relative(appDir, f) : '(no component file)';
const pageRoutes = allRouteNodes.filter(n => n.component && !n.isLayout);
const orphans = pageRoutes.filter(n => !n.reachable);
const reachable = pageRoutes.filter(n => n.reachable);

function fmtEntries(n) {
  const seen = new Set();
  const lines = [];
  for (const e of n.entries) {
    const key = e.kind + (e.file || '') + (e.line || '') + (e.raw || '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.file) lines.push(`      ↩ ${e.kind} @ ${rel(e.file)}:${e.line}  ${e.raw || ''}`);
    else lines.push(`      ↩ ${e.kind}  ${e.raw || ''}`);
  }
  return lines.join('\n');
}

let out = '';
const p = (s = '') => { out += s + '\n'; };

p(`\n═══════════════════════════════════════════════════════════════`);
p(` Navigation audit: ${appName}`);
p(`   src: ${rel(srcDir)}`);
p(`═══════════════════════════════════════════════════════════════`);
p(`\n  Route components (excl. Layout) : ${pageRoutes.length}`);
p(`  Reachable                       : ${reachable.length}`);
p(`  ⚠ Suspected orphan routes        : ${orphans.length}`);
p(`  Navigation targets collected    : ${navTargets.length}  (routerLink/navigate/sidebar)`);
p(`  Page components on disk         : ${pageComponentFiles.length}`);
p(`  Pages not referenced by a route : ${notRoutedPages.length}`);
p(`  Total components                : ${componentInfo.length}`);
p(`  ⚠ Orphan components (fully unused): ${orphanComponents.length}`);
p(`  (dialogs opened in code, etc.   : ${dialogLike.length}, normal — informational)`);

p(`\n───────────────────────────────────────────────────────────────`);
p(` ⚠ Suspected orphan routes (built, but no link/button reaches them)`);
p(`───────────────────────────────────────────────────────────────`);
if (!orphans.length) p('  (none) 🎉');
for (const n of orphans) {
  p(`\n  ✗ ${n.fullPath}`);
  p(`      component : ${n.component}  (${rel(n.componentFile)})`);
  p(`      defined   : ${rel(n.file)}:${n.line}`);
}

p(`\n───────────────────────────────────────────────────────────────`);
p(` ✓ Reachable routes (with entry points)`);
p(`───────────────────────────────────────────────────────────────`);
for (const n of reachable.sort((a, b) => a.fullPath.localeCompare(b.fullPath))) {
  p(`\n  ✓ ${n.fullPath}  →  ${n.component}`);
  const e = fmtEntries(n);
  if (e) p(e);
}

p(`\n───────────────────────────────────────────────────────────────`);
p(` Page components on disk not referenced by any route`);
p(` (may be a dialog/child; if neither, it's dead code)`);
p(`───────────────────────────────────────────────────────────────`);
if (!notRoutedPages.length) p('  (none)');
for (const f of notRoutedPages) {
  const importer = isImportedAnywhere(f);
  const tag = importer ? `imported by → ${rel(importer)} (likely a dialog/child)` : '❗ no import anywhere → suspected dead code';
  p(`  • ${rel(f)}`);
  p(`      ${tag}`);
}

p(`\n───────────────────────────────────────────────────────────────`);
p(` ⚠ Orphan components (not routed, selector unused, class unreferenced)`);
p(`───────────────────────────────────────────────────────────────`);
if (!orphanComponents.length) p('  (none) 🎉');
for (const c of orphanComponents) {
  p(`  ✗ ${c.className || '(?)'}  <${c.selector || '—'}>`);
  p(`      ${rel(c.file)}`);
}

p('');
console.log(out);

// Markdown output
if (mdOut) {
  let md = `# Navigation audit: ${appName}\n\n`;
  md += `> src: \`${rel(srcDir)}\`\n\n`;
  md += `| Metric | Count |\n|------|------|\n`;
  md += `| Route components (excl. Layout) | ${pageRoutes.length} |\n`;
  md += `| Reachable | ${reachable.length} |\n`;
  md += `| ⚠ Suspected orphan routes | ${orphans.length} |\n`;
  md += `| Pages not referenced by a route | ${notRoutedPages.length} |\n`;
  md += `| Total components | ${componentInfo.length} |\n`;
  md += `| ⚠ Orphan components (fully unused) | ${orphanComponents.length} |\n`;
  md += `| Dialogs opened in code, etc. (normal) | ${dialogLike.length} |\n\n`;

  md += `## ⚠ Orphan components (not routed, selector unused, class unreferenced)\n\n`;
  if (!orphanComponents.length) md += `(none) 🎉\n\n`;
  else {
    md += `| Component | selector | file |\n|------|------|------|\n`;
    for (const c of orphanComponents)
      md += `| ${c.className || '(?)'} | \`${c.selector || '—'}\` | \`${rel(c.file)}\` |\n`;
    md += '\n';
  }

  md += `## ⚠ Suspected orphan routes\n\n`;
  if (!orphans.length) md += `(none) 🎉\n\n`;
  else {
    md += `| Route | Component | Component file | Route defined |\n|------|------|--------|----------|\n`;
    for (const n of orphans)
      md += `| \`${n.fullPath}\` | ${n.component} | \`${rel(n.componentFile)}\` | \`${rel(n.file)}:${n.line}\` |\n`;
    md += '\n';
  }

  md += `## ✓ Reachable routes\n\n`;
  md += `| Route | Component | Entry |\n|------|------|------|\n`;
  for (const n of reachable.sort((a, b) => a.fullPath.localeCompare(b.fullPath))) {
    const ents = [];
    const seen = new Set();
    for (const e of n.entries) {
      const k = e.kind + (e.file || '') + (e.line || '');
      if (seen.has(k)) continue; seen.add(k);
      ents.push(e.file ? `${e.kind} \`${rel(e.file)}:${e.line}\`` : e.kind);
    }
    md += `| \`${n.fullPath}\` | ${n.component} | ${ents.join('<br>') || '—'} |\n`;
  }
  md += '\n';

  md += `## Page components not referenced by any route\n\n`;
  if (!notRoutedPages.length) md += `(none)\n`;
  else {
    md += `| Component file | Verdict |\n|--------|------|\n`;
    for (const f of notRoutedPages) {
      const importer = isImportedAnywhere(f);
      md += `| \`${rel(f)}\` | ${importer ? `imported by \`${rel(importer)}\` (dialog/child)` : '❗ no import → suspected dead code'} |\n`;
    }
  }
  writeFileSync(resolve(process.cwd(), mdOut), md);
  console.log(`Markdown report written: ${mdOut}`);
}

if (jsonOut) {
  const data = {
    app: appName,
    src: rel(srcDir),
    summary: {
      routeComponents: pageRoutes.length,
      reachable: reachable.length,
      orphans: orphans.length,
      navTargets: navTargets.length,
      notRoutedPages: notRoutedPages.length,
      totalComponents: componentInfo.length,
      orphanComponents: orphanComponents.length,
      dialogLike: dialogLike.length,
    },
    orphanComponents: orphanComponents.map(c => ({ className: c.className, selector: c.selector, file: rel(c.file) })),
    dialogLike: dialogLike.map(c => ({ className: c.className, selector: c.selector, file: rel(c.file), referencedIn: rel(c.refInTs) })),
    orphans: orphans.map(n => ({ path: n.fullPath, component: n.component, componentFile: rel(n.componentFile), defined: `${rel(n.file)}:${n.line}` })),
    reachable: reachable.map(n => ({ path: n.fullPath, component: n.component, entries: n.entries.map(e => ({ kind: e.kind, at: e.file ? `${rel(e.file)}:${e.line}` : null })) })),
    notRoutedPages: notRoutedPages.map(f => ({ file: rel(f), importedBy: isImportedAnywhere(f) ? rel(isImportedAnywhere(f)) : null })),
  };
  writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify(data, null, 2));
  console.log(`JSON report written: ${jsonOut}`);
}

// exit code: 1 if any orphan routes (CI-friendly)
process.exit(orphans.length ? 1 : 0);
