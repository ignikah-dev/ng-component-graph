# ng-component-graph

Draw the **"who composes whom"** relationship between **standalone Angular components** in an app, and flag components that sit alone in the composition graph.

It reads each `@Component`'s standalone `imports: [...]` array via the **TypeScript AST**. For standalone components that array is the authoritative list of which other components a template may use — so the graph is more accurate than scanning ES imports (e.g. with [madge](https://github.com/pahen/madge)), which also picks up services, pipes, and type-only imports that never appear in a template.

- 🟢 Zero runtime deps beyond your project's `typescript`
- 🧠 AST-based, not regex-based, edge detection
- 🖼 Output as **Mermaid**, **JSON**, or a colour-coded **graphviz** SVG/PNG
- 🔎 Distinguishes "isolated in the graph" from "actually dead" — **isolated ≠ orphan**

---

## Install

No install required — run it with `node` against any Angular app that has `typescript` on its path:

```bash
node component-graph.mjs <app-src-or-app-dir>
```

Or install globally / as a dev dependency:

```bash
npm i -D ng-component-graph
npx ng-component-graph apps/my-app
```

`typescript` is a peer dependency (any Angular project already has it). For SVG/PNG output you also need [graphviz](https://graphviz.org):

```bash
brew install graphviz      # macOS
apt install graphviz       # Debian/Ubuntu
```

### Windows

The tool is pure Node.js and works on Windows (paths are handled with `node:path`).

```powershell
# Node.js — install once (any one of these)
winget install OpenJS.NodeJS.LTS

# Run it (PowerShell or cmd) — same flags as everywhere else
node component-graph.mjs apps\my-app
npx ng-component-graph apps\my-app

# Optional: graphviz, only needed for --svg / --png
winget install Graphviz.Graphviz      # or: choco install graphviz / scoop install graphviz
```

After installing Graphviz, open a **new** terminal so `dot.exe` is on `PATH`
(`dot -V` should print a version). If `--svg`/`--png` reports *"is graphviz installed?"*,
that PATH refresh is almost always the fix. The Mermaid/JSON/DOT outputs need no Graphviz.

> Both `apps\my-app` and `apps/my-app` work as the argument on Windows.

---

## Usage

```bash
# Mermaid flowchart + summary to stdout
node component-graph.mjs apps/my-app

# Markdown report (embeds the Mermaid graph)
node component-graph.mjs apps/my-app --md graph.md

# Machine-readable nodes/edges/isolated
node component-graph.mjs apps/my-app --json graph.json

# Rendered, colour-coded image (needs graphviz)
node component-graph.mjs apps/my-app --svg graph.svg
node component-graph.mjs apps/my-app --png graph.png

# Raw graphviz DOT (style it yourself)
node component-graph.mjs apps/my-app --dot graph.dot
```

The argument can be the app directory (`apps/my-app`), its `src`, or its `src/app` — the
tool finds the source root itself.

### Example output

```
flowchart TD
  ProjectListComponent["app-project-list"]
  PageHeaderComponent["app-page-header"]
  ProjectListComponent --> PageHeaderComponent
  ...

✅ No suspect isolated components.
app=my-app  components=20  edges=11  isolated=8 (pages=8 / dialogs=0 / suspect=0)
```

---

## How it classifies "isolated" components

A component with no parent **and** no child edge is *isolated in the composition graph*.
That is **not** the same as being dead code — a route-level page legitimately has no parent
component. The tool sorts isolated nodes into four buckets (and colours them in the image):

| Colour | Bucket | Meaning |
|--------|--------|---------|
| 🟩 green | page with children | a page/component that composes others |
| ⬜ grey | composed child | used by a parent's `imports[]` |
| 🟦 blue | isolated page / bootstrap root | mounted by a route or `bootstrapApplication` / `rootComponent:` — **normal** |
| 🟪 purple | dialog | opened via `dialog.open(X)`, so its selector isn't in any template — **normal** |
| 🟥 red | **suspect** | not in a template, not a route, not a dialog — **verify manually** |

> ⚠️ The 🟥 **suspect** list is a *first-pass filter, not a verdict.* It can have false
> positives (e.g. a lazy route wired with an unusual pattern, or a component pulled in via a
> spread `imports: [...SHARED]`). Confirm "is this really dead?" with a route-aware orphan
> check and a `selector` + class-name grep before deleting anything.

---

## Recognised entry points

So that real entry points aren't mistaken for orphans, the tool resolves:

- **Routes** — `*.routes.ts` with `loadComponent: () => import('...').then(m => m.XComponent)`
  or `component: XComponent`.
- **Bootstrap** — `main.ts` using `bootstrapApplication(AppComponent, ...)`, a custom
  wrapper that passes `rootComponent: AppComponent`, or any `*Component` referenced in `main.ts`.
- **Dialogs** — any `*.open(XComponent)` call (e.g. `MatDialog` / CDK `Dialog`).

---

## Limitations

- **Standalone only.** Only `@Component({ standalone: true, imports: [...] })` composition is
  parsed; classic `NgModule` `declarations`/`imports` are out of scope.
- **`imports[]` must list identifiers.** A spread of a shared array
  (`imports: [...SHARED_IMPORTS]`) is not expanded, so members reached only that way may show
  as isolated. (They'll fall into 🟥 suspect — verify before acting.)
- **It maps composition, not data flow.** Services, signals, and inputs/outputs are not edges.

---

## License

[MIT](./LICENSE) © Ignikah
