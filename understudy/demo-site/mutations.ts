/**
 * The drift corpus.
 *
 * Every mutation breaks the flow's primary selector, so each one genuinely
 * exercises the repair ladder. What differs between them is how much of the
 * four-layer anchor survives -- which is exactly the thing worth measuring.
 *
 * Handlers in v1 bind via `data-role`, which observe() never emits as a
 * selector. That lets a mutation rename an id without breaking the page, and
 * keeps data-role out of the fallback ladder so repairs are not made to look
 * free by accident.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const LOAD = `<button id="load-btn" name="load" data-role="load" type="button">Load invoices</button>`
const EXPORT = `<button id="export-btn" name="export" data-role="export" type="submit">Export CSV</button>`

/** Replace the load button, which is the element every flow step targets. */
const swapLoad = (html: string, replacement: string): string => {
  if (!html.includes(LOAD)) throw new Error("load button markup drifted; update mutations.ts")
  return html.replace(LOAD, replacement)
}

export type Mutation = {
  name: string
  what: string
  expected: "fallback" | "anchor" | "llm" | "fail"
  apply: (html: string) => string
}

export const MUTATIONS: Mutation[] = [
  {
    name: "id-rename",
    what: "id renamed",
    expected: "fallback",
    apply: (h) => swapLoad(h, LOAD.replace('id="load-btn"', 'id="ldb-7f2a"')),
  },
  {
    name: "class-churn",
    what: "id removed, generated classes",
    expected: "fallback",
    apply: (h) => swapLoad(h, LOAD.replace('id="load-btn" ', 'class="_a7f2 _b91c" ')),
  },
  {
    name: "label-change",
    what: "id + name changed, new text",
    expected: "llm",
    apply: (h) =>
      swapLoad(
        h,
        `<button id="ldb-7f2a" name="fetch" data-role="load" type="button">Fetch statements</button>`,
      ),
  },
  {
    name: "i18n",
    what: "id + name changed, French text",
    expected: "llm",
    apply: (h) =>
      swapLoad(
        h,
        `<button id="ldb-7f2a" name="charger" data-role="load" type="button">Charger les factures</button>`,
      ),
  },
  {
    name: "reparent",
    what: "id + name changed, moved into a dropdown",
    expected: "llm",
    apply: (h) =>
      swapLoad(
        h,
        // `open` on purpose: this mutation is about structure moving, not
        // about an element being hidden. Collapsed would test click-ability.
        `<details open><summary>Actions</summary>` +
          `<button id="ldb-7f2a" name="fetch" data-role="load" type="button">Load invoices</button>` +
          `</details>`,
      ),
  },
  {
    name: "reorder",
    what: "id + name changed, siblings swapped",
    expected: "anchor",
    apply: (h) => {
      const renamed = LOAD.replace('id="load-btn"', 'id="ldb-7f2a"').replace(
        'name="load"',
        'name="fetch"',
      )
      return h.replace(`${LOAD}\n      ${EXPORT}`, `${EXPORT}\n      ${renamed}`)
    },
  },
  {
    name: "role-change",
    what: "id + name changed, button becomes an anchor",
    expected: "llm",
    apply: (h) =>
      swapLoad(
        h,
        `<a href="#" id="ldb-7f2a" name="fetch" data-role="load" role="button">Load invoices</a>`,
      ),
  },
  {
    name: "icon-only",
    what: "id + name changed, text replaced by an icon",
    expected: "llm",
    apply: (h) =>
      swapLoad(
        h,
        `<button id="ldb-7f2a" name="fetch" data-role="load" type="button" aria-label="Load">&#8595;</button>`,
      ),
  },
  {
    name: "shadow-dom",
    what: "controls wrapped in a shadow root",
    expected: "fail",
    apply: (h) => {
      // Playwright's locators DO pierce open shadow roots, so the id must
      // also change for this to be a real drift case. What breaks is observe():
      // querySelectorAll does not pierce, so the element is invisible to the
      // snapshot, and therefore to both anchor scoring and the model. A real
      // limitation, published as a failure.
      const hidden = LOAD.replace('id="load-btn"', 'id="ldb-7f2a"').replace(
        'name="load"',
        'name="fetch"',
      )
      const withHost = h.replace(
        `${LOAD}\n      ${EXPORT}`,
        `<div id="ctl-host"></div>
    <script>
      const __r = document.getElementById("ctl-host").attachShadow({ mode: "open" })
      __r.innerHTML = \`${hidden}${EXPORT}\`
      window.__shadow = __r
    </script>`,
      )
      // Rebind through the shadow root so the page still works.
      // No wrapping parens: the preceding statement is an array literal with
      // no semicolon, and a line starting with `(` would be parsed as calling
      // that array. Starting with `window.` keeps ASI out of it.
      return withHost.replace(
        /document\.querySelector\('\[data-role="(load|export)"\]'\)/g,
        `window.__shadow.querySelector('[data-role="$1"]')`,
      )
    },
  },
  {
    name: "ambiguous",
    what: "id + name changed, near-identical decoy added",
    expected: "fail",
    apply: (h) =>
      swapLoad(
        h,
        `<button id="ldb-decoy" name="refresh" type="button">Load invoices</button>\n      ` +
          `<button id="ldb-7f2a" name="fetch" data-role="load" type="button">Load invoices</button>`,
      ),
  },
]

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v1 = readFileSync(join(here, "v1", "index.html"), "utf8")
  for (const m of MUTATIONS) {
    const dir = join(here, `drift-${m.name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "index.html"), m.apply(v1), "utf8")
    console.log(`drift-${m.name.padEnd(14)} ${m.what}`)
  }
}
