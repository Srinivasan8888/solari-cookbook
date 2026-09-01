/**
 * Serves a demo-site variant on a port. Used by tests (which pick port 0 and
 * read back the assigned port) and by `npm run demo-site` for eyeballing it.
 */
import { createServer, type Server } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))

export type DemoServer = { url: string; close: () => Promise<void> }

export async function serveVariant(variant: string, port = 0): Promise<DemoServer> {
  const html = readFileSync(join(here, variant, "index.html"), "utf8")
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  const addr = server.address()
  if (addr === null || typeof addr === "string") throw new Error("no port assigned")
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const variant = process.argv[2] ?? "v1"
  const { url } = await serveVariant(variant, 8787)
  console.log(`${variant} serving at ${url}`)
}
