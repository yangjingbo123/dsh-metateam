/** Authenticated local-only bridge for custom commands unsupported by SDK query. */
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { object, text } from './types.ts'

export interface ControlRequest { sessionId: string; command: string }

/** Expose only /meta commands on a 0600 Unix socket, never a TCP listener. */
export async function startControl(
  path: string, token: string,
  execute: (request: ControlRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<() => Promise<void>> {
  if (token.length < 16) throw new Error('Control token requires at least 16 characters')
  if (existsSync(path)) throw new Error('Refuse to overwrite an existing control socket')
  mkdirSync(dirname(path), { recursive: true })
  const lifetime = new AbortController()
  const tasks = new Set<Promise<unknown>>()
  const server = createServer(async (req, res) => {
    const provided = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (req.method !== 'POST' || req.url !== '/meta' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.writeHead(403).end(); return
    }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString()
        if (Buffer.byteLength(body) > 256_000) throw new Error('Control request too large')
      }
      const args = object(JSON.parse(body))
      const request = { sessionId: text(args.sessionId, 'sessionId'), command: text(args.command, 'command') }
      if (!request.command.startsWith('/meta ')) throw new Error('Only /meta commands are allowed')
      const task = execute(request, lifetime.signal)
      tasks.add(task)
      let result: unknown
      try { result = await task } finally { tasks.delete(task) }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  server.requestTimeout = 10_000
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(path, () => { server.removeListener('error', fail); done() })
    })
    chmodSync(path, 0o600)
  } catch (error) { server.close(); throw error }
  return async () => {
    lifetime.abort(new Error('Control bridge disposed'))
    await Promise.allSettled([...tasks])
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() })
    if (existsSync(path)) rmSync(path)
  }
}
