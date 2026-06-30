# ng-component-graph

[![Release](https://img.shields.io/github/v/release/ignikah-dev/ng-component-graph?sort=semver&color=2da44e)](https://github.com/ignikah-dev/ng-component-graph/releases/latest)
[![License: MIT](https://img.shields.io/github/license/ignikah-dev/ng-component-graph?color=blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Draw the **full hierarchy** of a standalone Angular app:

```
app (bootstrap)  →  route (URL path)  →  page component  →  child component  →  child…
```

It reconstructs the real URL path tree from your `*.routes.ts` files and then expands each
page into the child components it composes — all parsed with the **TypeScript AST**, so the
edges match what your routes and templates actually wire up.

- 🧭 Reconstructs the **route tree**: inline `children`, lazy `loadChildren`, `loadComponent`, `component:`, `redirectTo`, and `data.title`
- 🧩 Expands each page via its standalone `@Component({ imports: [...] })` into child components — **AST-based, not regex**
- 🟦 Flags **layout shell** routes, 🟧 **dual-role** "page-in-page" components, and ⬚ **external/unresolved** lazy children
- 🟥 Optionally highlights **orphan routes** (no inbound navigation) — pair it with the bundled [`nav-audit`](#companion-nav-audit) tool
- 🟢 Zero runtime deps beyond your project's `typescript`; renders with [graphviz](https://graphviz.org)

> **Two tools, one package.** `component-graph` maps *structure*; its companion
> [`nav-audit`](#companion-nav-audit) maps *reachability* (which routes nothing links to).
> Pipe one into the other to paint dead routes red.

![Example app → route → page → component graph](https://raw.githubusercontent.com/ignikah-dev/ng-component-graph/main/docs/example-graph.png)

> Generated from the bundled [`examples/demo-app`](examples/demo-app):
> ```bash
> node component-graph.mjs examples/demo-app --png docs/example-graph.png
> ```
> The yellow **app root** fans out into cream **route paths**, each route points (green arrow)
> to its green **page component**, and pages expand into grey **child components** — note
> `app-empty-state` is shared by two pages.

---

## Install

No install required — run it with `node` against any Angular app that has `typescript` on its path:

```bash
node component-graph.mjs <app-dir> --svg graph.svg
```

Or install globally / as a dev dependency:

```bash
npm i -D ng-component-graph
npx ng-component-graph apps/my-app --svg graph.svg
```

`typescript` is a peer dependency (any Angular project already has it). Rendering to SVG/PNG
needs [graphviz](https://graphviz.org):

```bash
brew install graphviz      # macOS
apt install graphviz       # Debian/Ubuntu
```

### Windows

The tool is pure Node.js and works on Windows (paths are handled with `node:path`).

```powershell
winget install OpenJS.NodeJS.LTS          # Node.js (once)
node component-graph.mjs apps\my-app --svg graph.svg
npx ng-component-graph apps\my-app --svg graph.svg

winget install Graphviz.Graphviz          # optional, for --svg / --png
```

After installing Graphviz, open a **new** terminal so `dot.exe` is on `PATH` (`dot -V` should
print a version). Both `apps\my-app` and `apps/my-app` work as the argument.

---

## Usage

```bash
# DOT to stdout + summary to stderr (no graphviz needed)
node component-graph.mjs apps/my-app

# Rendered image (needs graphviz)
node component-graph.mjs apps/my-app --svg graph.svg
node component-graph.mjs apps/my-app --png graph.png

# Raw graphviz DOT to a file (style it yourself)
node component-graph.mjs apps/my-app --dot graph.dot

# Highlight orphan routes in red (see below)
node component-graph.mjs apps/my-app --svg graph.svg --nav-json orphans.json
```

The argument can be the app directory (`apps/my-app`), its `src`, or its `src/app` — the tool
finds the source root and the app's root `Routes` (`appRoutes`, or the array exported from
`app.routes.ts`) itself.

### Example summary (stderr)

```
app=my-app  routes=16  page-comps=9  child-comps=8  dual-role=0
route exports never loaded via loadChildren: COMPOSITION_ROUTES(0)
```

---

## What the colours mean

| Colour | Node | Meaning |
|--------|------|---------|
| 🟡 yellow | app root | the bootstrapped application |
| 🟦 blue | layout shell route | a route whose `component:` name contains `Layout` |
| 🟧 cream | route path | a reconstructed URL path (with `data.title` if present) |
| 🟢 green | page component | the component a route mounts |
| ⬜ grey | child component | composed by a page via `imports[]` |
| 🟧 amber | ★ route+child | a component that is **both** a route target **and** another page's child (a "page-in-page") |
| ⬚ dashed grey | external/unresolved | a `loadChildren` whose route export isn't found in this app |
| 🟥 red | orphan route | (with `--nav-json`) a route with no inbound navigation |

It also reports on stderr any exported `Routes` array that is **never** `loadChildren`'d —
often a leftover/empty routes file.

---

## Companion: `nav-audit`

`component-graph` maps *structure* — it doesn't decide which routes are actually **reachable**.
The bundled `nav-audit.mjs` does exactly that: it cross-checks "route → component" against every
navigation target it can find (`routerLink`, `router.navigate` / `navigateByUrl`, sidebar/menu
`route:` data, shared-layout `get*Route()` methods), then reports:

- **orphan routes** — built and routable, but nothing links to them
- **orphan components** — not routed, selector never used, class referenced nowhere (dead code)
- **pages not referenced by any route** — likely a dialog/child, or dead code

```bash
node nav-audit.mjs apps/my-app                 # human-readable report (exit 1 if orphan routes)
node nav-audit.mjs apps/my-app --md report.md  # markdown
node nav-audit.mjs apps/my-app --json out.json # machine-readable (and the --nav-json input below)
```

### The pipeline: paint orphan routes red

`nav-audit --json` emits exactly the shape `component-graph --nav-json` consumes, so the two compose:

```bash
node nav-audit.mjs       apps/my-app --json orphans.json
node component-graph.mjs apps/my-app --svg graph.svg --nav-json orphans.json
```

Any route whose `path` (or page `component`) is listed as an orphan is drawn red:

![Orphan route highlighted](https://raw.githubusercontent.com/ignikah-dev/ng-component-graph/main/docs/example-graph-orphans.png)

> In the bundled demo, `app-root` links to `/dashboard` and `/orders` but **not** `/settings`,
> so `nav-audit` flags `/settings` and `component-graph` paints it red. Reproduce:
> ```bash
> node nav-audit.mjs       examples/demo-app --json orphans.json
> node component-graph.mjs examples/demo-app --png docs/example-graph-orphans.png --nav-json orphans.json
> ```

The `--nav-json` shape, if you'd rather generate it yourself:

```json
{ "orphans": [ { "path": "/settings", "component": "SettingsPageComponent" } ] }
```

`nav-audit`'s heuristics (which filenames are sidebars, which names are layout shells) are noted
at the top of `nav-audit.mjs` — tune them to your conventions.

---

## Limitations

- **Standalone only.** Composition is read from `@Component({ imports: [...] })`; classic
  `NgModule` `declarations`/`imports` are out of scope.
- **`imports[]` must list identifiers.** A spread of a shared array (`imports: [...SHARED]`)
  isn't expanded, so members reached only that way won't show as children.
- **Route reconstruction is static.** Path params (`:id`) are kept verbatim; programmatic
  `router.navigate` targets aren't resolved. The "never loadChildren'd" report is a heuristic —
  a routes array pulled in by a direct `import` + spread (rather than `loadChildren`) may be
  reported even though it is used.

---

## License

[MIT](./LICENSE) © Ignikah
