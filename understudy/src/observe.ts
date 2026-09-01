import type { Page } from "playwright"

export type SnapshotNode = {
  idx: number
  role: string
  name: string
  nameNormalized: string
  attrs: { testId: string | null; name: string | null; type: string | null }
  nearText: string[]
  landmarks: string[]
  siblingOrdinal: number
  siblingRole: string
  textFingerprint: string[]
  selector: string
}

export type Snapshot = { url: string; nodes: SnapshotNode[] }

export const MAX_NODES = 120

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function fingerprint(text: string): string[] {
  return [...new Set(normalize(text).split(/[^a-z0-9]+/).filter((t) => t.length > 1))]
}

type RawNode = Omit<SnapshotNode, "nameNormalized" | "textFingerprint">

/**
 * The page, reduced to the interactive elements an agent could act on.
 * Never send raw HTML to a model: this is roughly 20x cheaper per turn, and
 * it turns the model's job into picking from a list rather than parsing a
 * document.
 */
export async function observe(page: Page): Promise<Snapshot> {
  // esbuild (via tsx) rewrites nested functions to call a `__name` helper it
  // injects at module scope. page.evaluate serializes the callback and runs it
  // in the browser, where that helper does not exist -- so every call throws
  // `__name is not defined`. Vitest's transform does not do this, which is why
  // the suite stayed green while the tsx entry point was broken. Shim it with a
  // raw string, which is never transformed.
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)")

  const nodes: RawNode[] = await page.evaluate((maxNodes) => {
    const INTERACTIVE =
      "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem]"

    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute("role")
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === "a") return el.hasAttribute("href") ? "link" : "generic"
      if (tag === "button" || tag === "summary") return "button"
      if (tag === "select") return "combobox"
      if (tag === "textarea") return "textbox"
      if (tag === "input") {
        const t = (el.getAttribute("type") ?? "text").toLowerCase()
        if (t === "checkbox" || t === "radio") return t
        if (t === "submit" || t === "button" || t === "reset") return "button"
        return "textbox"
      }
      return "generic"
    }

    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label")
      if (aria && aria.trim()) return aria.trim()
      const by = el.getAttribute("aria-labelledby")
      if (by) {
        const t = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim()
        if (t) return t
      }
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        const t = lab?.textContent?.trim()
        if (t) return t
      }
      const wrapping = el.closest("label")
      const wrapped = wrapping?.textContent?.trim()
      if (wrapped) return wrapped
      const ph = el.getAttribute("placeholder")
      if (ph && ph.trim()) return ph.trim()
      const value = (el as HTMLInputElement).value
      if (el.tagName === "INPUT" && value) return value
      return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
    }

    const selectorFor = (el: Element): string => {
      const testId = el.getAttribute("data-testid")
      if (testId) return `[data-testid="${testId}"]`
      if (el.id) return `#${CSS.escape(el.id)}`
      const parts: string[] = []
      let cur: Element | null = el
      while (cur && cur !== document.body && parts.length < 4) {
        const parent: Element | null = cur.parentElement
        if (!parent) break
        const tag = cur.tagName.toLowerCase()
        const node: Element = cur
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === node.tagName,
        ) as Element[]
        parts.unshift(
          sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag,
        )
        cur = parent
      }
      return parts.join(" > ")
    }

    const LANDMARK_TAGS = ["main", "nav", "header", "footer", "aside", "form", "section"]

    const landmarksFor = (el: Element): string[] => {
      const out: string[] = []
      let cur: Element | null = el.parentElement
      while (cur && cur !== document.documentElement) {
        const tag = cur.tagName.toLowerCase()
        if (LANDMARK_TAGS.indexOf(tag) !== -1) {
          const label = cur.getAttribute("aria-label")
          out.unshift(label ? `${tag}[${label}]` : tag)
        }
        cur = cur.parentElement
      }
      return out.slice(-3)
    }

    const nearTextFor = (el: Element): string[] => {
      const out: string[] = []
      let cur: Element | null = el.parentElement
      let hops = 0
      while (cur && hops < 3) {
        for (const child of Array.from(cur.children)) {
          if (child === el || child.contains(el)) continue
          const t = (child.textContent ?? "").replace(/\s+/g, " ").trim()
          if (t && t.length <= 40) out.push(t)
        }
        cur = cur.parentElement
        hops++
      }
      return Array.from(new Set(out)).slice(0, 5)
    }

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    // Text the element owns directly, not text inherited from descendants.
    // Without this a wrapper <div> would claim the whole page as its content.
    const ownText = (el: Element): string =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

    const interactive = Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible)
    const claimed = new Set(interactive)

    // Content nodes: where extracted data actually lives. Interactive elements
    // alone cannot express "read the result", which is the point of a flow
    // that returns something. Kept narrow -- addressable or tabular, with its
    // own short text -- so the snapshot stays cheap.
    const CONTENT = "[id], td, th, [role=status], [aria-live]"
    const content = Array.from(document.querySelectorAll(CONTENT)).filter(
      (el) => !claimed.has(el) && visible(el) && ownText(el).length > 0 && ownText(el).length <= 200,
    )

    const els = [...interactive, ...content]

    return els.slice(0, maxNodes).map((el, idx) => {
      const role = roleOf(el)
      const parent = el.parentElement
      const sameRole = parent
        ? (Array.prototype.filter.call(
            parent.children,
            (c: Element) => roleOf(c) === role,
          ) as Element[])
        : [el]
      const isInteractive = claimed.has(el)
      return {
        idx,
        role,
        name: isInteractive ? nameOf(el) : ownText(el).slice(0, 80),
        attrs: {
          testId: el.getAttribute("data-testid"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
        },
        nearText: nearTextFor(el),
        landmarks: landmarksFor(el),
        siblingOrdinal: sameRole.indexOf(el),
        siblingRole: role,
        selector: selectorFor(el),
      }
    })
  }, MAX_NODES)

  return {
    url: page.url(),
    nodes: nodes.map((n) => ({
      ...n,
      nameNormalized: normalize(n.name),
      textFingerprint: fingerprint(`${n.name} ${n.nearText.join(" ")}`),
    })),
  }
}
