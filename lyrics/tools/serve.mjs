// Minimal static file server for local preview and the e2e tests.
// Usage: node tools/serve.mjs [port]   (serves the lyrics/ folder; port 0 = any free port)
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.lrc': 'text/plain; charset=utf-8',
}

export function startServer(port = 0, root = ROOT) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
      let file = join(root, path)
      if (!file.startsWith(root)) {
        res.writeHead(403).end('Forbidden')
        return
      }
      const info = await stat(file).catch(() => null)
      if (info?.isDirectory()) file = join(file, 'index.html')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    }
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8080)
  const server = await startServer(port)
  console.log(`StageLyrics running at http://127.0.0.1:${server.address().port}/`)
}
