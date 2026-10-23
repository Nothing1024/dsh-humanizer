import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { LlamaServerClient, serialize } from '../src/client.ts'

let servers: Server[] = []
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  servers = []
})

/** Fake llama-server: /completion streams 3 chunks + a final stop frame. */
async function fakeLlama(opts: { stopType?: string } = {}): Promise<{ base: string; seen: Array<Record<string, unknown>>; auth: string[] }> {
  const seen: Array<Record<string, unknown>> = []
  const auth: string[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    auth.push(String(req.headers.authorization ?? ''))
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); return }
    const body = JSON.parse(raw) as Record<string, unknown>
    seen.push(body)
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      for (const piece of ['Hel', 'lo, ', 'world']) {
        res.write(`data: ${JSON.stringify({ content: piece, stop: false })}\n\n`)
        await new Promise((r) => setTimeout(r, 3))
      }
      res.end(`data: ${JSON.stringify({ content: '', stop: true, stop_type: opts.stopType ?? 'eos', tokens_predicted: 3 })}\n\n`)
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ content: 'Hello, world', stop_type: opts.stopType ?? 'eos', tokens_predicted: 3 }))
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, auth }
}

describe('llama-server client streaming', () => {
  it('streams /completion with the same sampling and result as the plain call', async () => {
    const { base, seen, auth } = await fakeLlama()
    const c = new LlamaServerClient({ baseURL: `${base}/v1`, apiKey: async () => 'sk-x', requestTimeoutMs: 5000 })
    const deltas: string[] = []
    const r = await c.complete('P', 300, new AbortController().signal, (t) => deltas.push(t))
    expect(r.text).toBe('Hello, world')
    expect(r.truncated).toBe(false)
    expect(deltas).toEqual(['Hel', 'Hello, ', 'Hello, world'])
    const plain = await c.complete('P', 300, new AbortController().signal)
    expect(plain.text).toBe(r.text)
    const { stream, ...rest } = seen[0]!
    expect(stream).toBe(true)
    expect(rest).toEqual(seen[1])
    expect(rest).toMatchObject({ prompt: 'P', n_predict: 300, temperature: 1, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1 })
    expect(rest).not.toHaveProperty('stop')
    expect(auth.every((a) => a === 'Bearer sk-x')).toBe(true)
    expect((await c.health(new AbortController().signal)).ok).toBe(true)
  })

  it('reports a streamed cut-off as truncated', async () => {
    const { base } = await fakeLlama({ stopType: 'limit' })
    const c = new LlamaServerClient({ baseURL: base, apiKey: async () => undefined, requestTimeoutMs: 5000 })
    const r = await c.complete('P', 256, new AbortController().signal, () => {})
    expect(r.truncated).toBe(true)
  })
})

describe('per-endpoint queue', () => {
  it('lets a waiting request be cancelled without running it', async () => {
    let release!: () => void
    const ran: string[] = []
    const first = serialize('q', () => new Promise<void>((r) => { release = () => { ran.push('a'); r() } }))
    const ctl = new AbortController()
    const second = serialize('q', async () => { ran.push('b') }, ctl.signal)
    const third = serialize('q', async () => { ran.push('c') })
    ctl.abort(new Error('stop'))
    await expect(second).rejects.toThrow('stop')
    release()
    await first
    await third
    expect(ran).toEqual(['a', 'c'])
  })
})
