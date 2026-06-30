#!/usr/bin/env node
/**
 * component-graph.mjs
 * --------------------------------------------------------------------------
 * Draw the "who composes whom" relationship between standalone Angular
 * components in an app, and flag components that sit alone in the graph.
 *
 * For standalone components, the @Component `imports: [...]` array is the
 * authoritative list of which other components a template may use — so this
 * tool parses that array with the TypeScript AST. That is more accurate than
 * scanning ES imports (e.g. with madge), which also picks up services, pipes
 * and type-only imports that never appear in a template.
 *
 * Usage:
 *   node component-graph.mjs <app-src-or-app-dir>
 *        [--md out.md] [--json out.json] [--dot out.dot] [--svg out.svg] [--png out.png]
 *   (--svg / --png require graphviz: `brew install graphviz` / `apt install graphviz`)
 *
 * Examples:
 *   node component-graph.mjs apps/my-app
 *   node component-graph.mjs apps/my-app --md graph.md
 *   node component-graph.mjs apps/my-app --svg graph.svg
 *
 * What it does:
 *   1. Scan every *.component.ts under the app src; via the TS AST read each
 *      @Component's class name, selector, and standalone `imports: [...]`.
 *   2. Build `parent -> child` edges where a parent's imports[] references
 *      another component defined in the same app.
 *   3. Resolve *.routes.ts (loadComponent / component:) and main.ts bootstrap
 *      to recognise route-mounted pages and the bootstrap root.
 *   4. Classify "isolated" nodes (no parent/child edge) so isolated != orphan:
 *        - route-mounted page / bootstrap root   -> normal
 *        - opened via dialog.open(X)             -> normal
 *        - none of the above                     -> SUSPECT (verify manually)
 *   5. Emit a Mermaid flowchart + summary; optional Markdown / JSON / graphviz.
 *
 * Note: only standalone `imports[]` is parsed (NgModule declarations/imports
 *       are out of scope). The SUSPECT list is a first-pass filter, not a
 *       verdict — confirm dead code with a route-aware orphan check / grep.
 *
 * License: MIT
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------- args ----------
const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flag = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const input = positional[0];
const mdOut = flag('--md');
const jsonOut = flag('--json');
const dotOut = flag('--dot');
const svgOut = flag('--svg');
const pngOut = flag('--png');

if (!input) {
  console.error('Usage: node component-graph.mjs <app-src-or-app-dir> [--md out.md] [--json out.json] [--dot out.dot] [--svg out.svg] [--png out.png]');
  process.exit(2);
}

// Accept either the app dir or its src dir.
let srcDir = resolve(process.cwd(), input);
if (existsSync(join(srcDir, 'src', 'app'))) srcDir = join(srcDir, 'src', 'app');
else if (existsSync(join(srcDir, 'app'))) srcDir = join(srcDir, 'app');
else if (existsSync(join(srcDir, 'src'))) srcDir = join(srcDir, 'src');
if (!existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`);
  process.exit(2);
}
const appName = input.replace(/\/+$/, '').split('/').filter(Boolean).pop();
const rel = p => relative(process.cwd(), p);

// ---------- collect files ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'api') continue; // skip deps + generated client
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const allFiles = walk(srcDir);
const componentFiles = allFiles.filter(f => /\.component\.ts$/.test(f) && !/\.spec\.ts$/.test(f));
const routeFiles = allFiles.filter(f => /\.routes\.ts$/.test(f) || /app\.routes\.ts$/.test(f));

// ---------- parse each component ----------
function parse(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let info = null;
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const deco = ts.getDecorators?.(node)?.find(d => {
        const e = d.expression;
        return ts.isCallExpression(e) && e.expression.getText(sf) === 'Component';
      });
      if (deco) {
        const arg = deco.expression.arguments[0];
        let selector = null;
        const imports = [];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const key = p.name.getText(sf);
            if (key === 'selector' && ts.isStringLiteral(p.initializer)) selector = p.initializer.text;
            if (key === 'imports' && ts.isArrayLiteralExpression(p.initializer)) {
              for (const el of p.initializer.elements) imports.push(el.getText(sf).trim());
            }
          }
        }
        info = { className: node.name.getText(sf), selector, imports, file };
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return info;
}

const components = componentFiles.map(parse).filter(Boolean);
const byClass = new Map(components.map(c => [c.className, c]));

// ---------- edges: imports[] members that are app components ----------
const edges = [];
const hasOutgoing = new Set();
const hasIncoming = new Set();
for (const c of components) {
  for (const imp of c.imports) {
    // an imports[] entry may be `FooComponent` or `FooComponent /* comment */`; take the identifier
    const idMatch = imp.match(/[A-Za-z_$][A-Za-z0-9_$]*/);
    const id = idMatch ? idMatch[0] : imp;
    if (byClass.has(id) && id !== c.className) {
      edges.push([c.className, id]);
      hasOutgoing.add(c.className);
      hasIncoming.add(id);
    }
  }
}

// ---------- route-mounted components (so "isolated" can exclude pages) ----------
const routeMounted = new Set();
for (const rf of routeFiles) {
  const txt = readFileSync(rf, 'utf8');
  // loadComponent: () => import('...').then(m => m.FooComponent)  or  component: FooComponent
  for (const m of txt.matchAll(/\bm\.([A-Za-z_$][A-Za-z0-9_$]*Component)\b/g)) routeMounted.add(m[1]);
  for (const m of txt.matchAll(/\bcomponent:\s*([A-Za-z_$][A-Za-z0-9_$]*Component)\b/g)) routeMounted.add(m[1]);
}

// ---------- bootstrap root component (a legitimate entry point) ----------
// main.ts usually lives in src/ (one level above srcDir = src/app), outside the walk.
const bootstrapRoots = new Set();
const mainCandidates = [join(srcDir, '..', 'main.ts'), join(srcDir, 'main.ts'), ...allFiles.filter(f => /(^|\/)main\.ts$/.test(f))];
for (const f of mainCandidates) {
  if (!existsSync(f)) continue;
  const txt = readFileSync(f, 'utf8');
  // standard bootstrapApplication(AppComponent, ...)
  for (const m of txt.matchAll(/bootstrapApplication\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) bootstrapRoots.add(m[1]);
  // custom bootstrap wrappers that pass `rootComponent: AppComponent`
  for (const m of txt.matchAll(/rootComponent:\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) bootstrapRoots.add(m[1]);
  // fallback: any *Component referenced in main.ts is treated as an entry point
  for (const m of txt.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*Component)\b/g)) bootstrapRoots.add(m[1]);
}

// ---------- components opened via dialog.open(X) ----------
// Their selector is not in any template by design, so don't treat them as suspects.
const dialogOpened = new Set();
for (const f of allFiles.filter(f => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f))) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/\.open\(\s*([A-Za-z_$][A-Za-z0-9_$]*Component)\b/g)) dialogOpened.add(m[1]);
}

// ---------- isolated (no parent/child edge in the composition graph) ----------
const isolated = components.filter(c => !hasOutgoing.has(c.className) && !hasIncoming.has(c.className));
const isLegit = c => routeMounted.has(c.className) || bootstrapRoots.has(c.className);
const isolatedPages = isolated.filter(isLegit);
const isolatedDialogs = isolated.filter(c => !isLegit(c) && dialogOpened.has(c.className));
const isolatedOther = isolated.filter(c => !isLegit(c) && !dialogOpened.has(c.className));

// ---------- Mermaid ----------
const nodeId = cls => cls.replace(/[^A-Za-z0-9]/g, '_');
const label = c => (c.selector || c.className);
function mermaid() {
  const lines = ['flowchart TD'];
  const inGraph = new Set(edges.flat());
  for (const cls of inGraph) {
    const c = byClass.get(cls);
    lines.push(`  ${nodeId(cls)}["${label(c)}"]`);
  }
  for (const [a, b] of edges) lines.push(`  ${nodeId(a)} --> ${nodeId(b)}`);
  return lines.join('\n');
}

// ---------- DOT (graphviz; all nodes, colour-coded by role) ----------
const suspectSet = new Set(isolatedOther.map(c => c.className));
const dialogSet = new Set(isolatedDialogs.map(c => c.className));
const pageSet = new Set(isolatedPages.map(c => c.className));
function role(cls) {
  if (suspectSet.has(cls)) return { fill: '#ffd6d6', stroke: '#d62828' };  // red: suspect
  if (dialogSet.has(cls)) return { fill: '#e7d6ff', stroke: '#7b2ff7' };   // purple: dialog
  if (pageSet.has(cls)) return { fill: '#d6e4ff', stroke: '#1d4ed8' };     // blue: isolated page/root
  if (routeMounted.has(cls) || bootstrapRoots.has(cls)) return { fill: '#d6f5dd', stroke: '#1a7f37' }; // green: composed page
  return { fill: '#f4f4f4', stroke: '#666' };                              // grey: child component
}
function dot() {
  const lines = [
    'digraph components {',
    '  rankdir=TB;',
    `  graph [fontname="Helvetica", label="${appName} — component composition", labelloc=t, fontsize=18];`,
    '  node  [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11];',
    '  edge  [color="#888", arrowsize=0.7];',
  ];
  for (const c of components) {
    const r = role(c.className);
    lines.push(`  "${c.className}" [label="${label(c)}", fillcolor="${r.fill}", color="${r.stroke}"];`);
  }
  for (const [a, b] of edges) lines.push(`  "${a}" -> "${b}";`);
  lines.push('  subgraph cluster_legend {');
  lines.push('    label="legend"; fontsize=12; style=dashed; color="#bbb";');
  const legend = [
    ['L_page', 'page with children', '#d6f5dd', '#1a7f37'],
    ['L_child', 'composed child', '#f4f4f4', '#666'],
    ['L_route', 'isolated page/root (ok)', '#d6e4ff', '#1d4ed8'],
    ['L_dialog', 'dialog.open (ok)', '#e7d6ff', '#7b2ff7'],
    ['L_suspect', 'suspect (verify)', '#ffd6d6', '#d62828'],
  ];
  for (const [id, txt, fill, stroke] of legend)
    lines.push(`    ${id} [label="${txt}", fillcolor="${fill}", color="${stroke}"];`);
  lines.push('    ' + legend.map(l => l[0]).join(' -> ') + ' [style=invis];');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n');
}
function render(format, outPath) {
  try {
    execFileSync('dot', ['-T' + format, '-o', resolve(process.cwd(), outPath)], { input: dot() });
    console.log(`${format.toUpperCase()} written: ${outPath}`);
  } catch (e) {
    console.error(`Failed to render ${format} (is graphviz installed?): ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------- graphviz file outputs ----------
if (dotOut) { writeFileSync(resolve(process.cwd(), dotOut), dot()); console.log(`DOT written: ${dotOut}`); }
if (svgOut) render('svg', svgOut);
if (pngOut) render('png', pngOut);

// ---------- text / markdown / json outputs ----------
const hasFileOut = mdOut || jsonOut || dotOut || svgOut || pngOut;
const summary =
  `app=${appName}  components=${components.length}  edges=${edges.length}  ` +
  `isolated=${isolated.length} (pages=${isolatedPages.length} / dialogs=${isolatedDialogs.length} / suspect=${isolatedOther.length})`;

if (!hasFileOut) {
  console.log('```mermaid');
  console.log(mermaid());
  console.log('```');
  console.log('');
  if (isolatedPages.length)
    console.log('Isolated but route page / bootstrap root (ok): ' + isolatedPages.map(label).join(', '));
  if (isolatedDialogs.length)
    console.log('Isolated but opened via dialog.open() (ok): ' + isolatedDialogs.map(c => c.className).join(', '));
  if (isolatedOther.length) {
    console.log('⚠️ Suspect — not in a template, route, or dialog (verify manually):');
    for (const c of isolatedOther) console.log('   - ' + c.className + '  ' + rel(c.file));
  } else {
    console.log('✅ No suspect isolated components.');
  }
}
console.error(summary);

if (mdOut) {
  const md = [
    `# ${appName} — Component composition graph`,
    '',
    `> Tool: \`component-graph.mjs\` · Source: \`${rel(srcDir)}\``,
    `> ${summary}`,
    '> Isolated != orphan; this graph only reflects standalone `imports[]` parent/child composition.',
    '',
    '## Graph',
    '',
    '```mermaid',
    mermaid(),
    '```',
    '',
    '## Isolated nodes (no parent/child edge)',
    '',
    '> Isolated != orphan. Route pages / bootstrap roots / dialogs have no parent component by design.',
    '',
    '### Route pages / bootstrap root (ok)',
    isolatedPages.length ? isolatedPages.map(c => `- \`${c.className}\` (${c.selector || 'no selector'})`).join('\n') : '_(none)_',
    '',
    '### Dialogs (opened via dialog.open(), ok)',
    isolatedDialogs.length ? isolatedDialogs.map(c => `- \`${c.className}\``).join('\n') : '_(none)_',
    '',
    '### ⚠️ Suspect (not in template/route/dialog — verify manually)',
    isolatedOther.length ? isolatedOther.map(c => `- \`${c.className}\` — \`${rel(c.file)}\``).join('\n') : '_(none)_',
    '',
  ].join('\n');
  writeFileSync(resolve(process.cwd(), mdOut), md);
  console.log(`Markdown written: ${mdOut}`);
}

if (jsonOut) {
  const data = {
    app: appName,
    src: rel(srcDir),
    summary: {
      components: components.length,
      edges: edges.length,
      isolated: isolated.length,
      isolatedPages: isolatedPages.length,
      isolatedDialogs: isolatedDialogs.length,
      isolatedOther: isolatedOther.length,
    },
    nodes: components.map(c => ({ className: c.className, selector: c.selector, file: rel(c.file), routeMounted: routeMounted.has(c.className), dialogOpened: dialogOpened.has(c.className) })),
    edges: edges.map(([a, b]) => ({ from: a, to: b })),
    isolatedOther: isolatedOther.map(c => ({ className: c.className, selector: c.selector, file: rel(c.file) })),
  };
  writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify(data, null, 2));
  console.log(`JSON written: ${jsonOut}`);
}
