/**
 * Settings: schema (defaults, bilingual descriptions, volatile = editable by dsh-settings,
 * validation), live apply through `loader/volatile-update`, secret masking on the settings
 * routes, the connection probe, and settings defaults reaching tool calls and UI jobs.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as toolHumanize from '../src/index.ts'
import { Config, DEFAULTS, readSettings, samplingDeviations } from '../src/settings.ts'
import { FIELDS, OFFICIAL_KEYS, checkValue, splitTerms } from '../src/settings-meta.ts'
import { LlamaServerClient, retryDelays } from '../src/client.ts'
import type { CompletionResult, HumanizerBackend, ProbeResult } from '../src/client.ts'
import { SAMPLING } from '../src/prompt.ts'

const WRITE = Symbol.for('cosmokit.volatile.write')
const EN = 'Our team shipped 3 releases in 2026 and support response times dropped to 4 hours across all regions.'
const GOOD_EN = 'Three releases went out in 2026. Support now answers within 4 hours, everywhere.'
const SECRET = 'sk-test-SECRET-value-123'
const LITERAL = 'sk-literal-SECRET-456'

let servers: Server[] = []
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  servers = []
})

class Fake implements HumanizerBackend {
  readonly label = 'fake'
  calls = 0
  keep: string[] = []
  async tokenize(): Promise<number> { return 30 }
  async complete(prompt: string): Promise<CompletionResult> { this.calls++; this.keep.push(prompt); return { text: GOOD_EN, truncated: false, tokensPredicted: 20, ms: 1 } }
  async health(): Promise<{ ok: boolean; status: number }> { return { ok: true, status: 200 } }
  async probe(): Promise<ProbeResult> { return { health: { ok: true, status: 200, message: 'ok' }, auth: { ok: true, status: 200, ms: 3, tokens: 4 } } }
}

/** Set a volatile field the way the Loader commits a settings save, then notify the plugin. */
function commit(ctx: Context, config: Record<string, unknown>, path: string[], value: unknown): void {
  let ref: unknown = config[path[0]!]
  if (path.length === 2) ref = (ref as Record<string, unknown>)[path[1]!]
  ;(ref as Record<symbol, (v: unknown) => void>)[WRITE]!(value)
  ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('loader/volatile-update', [path])
}

interface Mounted {
  ctx: Context
  config: Record<string, unknown>
  fake: Fake
  routes: Array<(req: IncomingMessage, res: ServerResponse) => void>
  restore: () => void
}

async function mount(raw: Record<string, unknown> = {}, opts: { secret?: string; web?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context()
  const provide = (name: string, value: unknown): void => {
    ;(ctx as unknown as { provide(name: string): void }).provide(name)
    ctx.set(name as never, value as never)
  }
  if (opts.secret !== undefined) {
    provide('credentials', {
      resolve: async (ref: string) => (ref === 'HUMANIZER_TEST_API_KEY' ? { value: opts.secret, source: 'file' } : undefined),
      describe: async (ref: string) => ({ configured: ref === 'HUMANIZER_TEST_API_KEY', ...ref === 'HUMANIZER_TEST_API_KEY' ? { source: 'file' } : {}, writable: true }),
    })
  }
  const routes: Mounted['routes'] = []
  if (opts.web) {
    provide('webServer', { register: (r: { handler: Mounted['routes'][number] }) => { routes.push(r.handler); return () => { routes.splice(routes.indexOf(r.handler), 1) } } })
    provide('connection', { requestRejection: () => undefined })
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const fake = new Fake()
  const restore = toolHumanize.setBackendFactory(() => fake)
  const config = Config(raw as never) as unknown as Record<string, unknown>
  await ctx.plugin({ name: 'host', inject: ['tools', 'systemPrompt'], apply: (c: Context) => { toolHumanize.apply(c, config as never) } } as never, undefined as never)
  return { ctx, config, fake, routes, restore }
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map((s: { name: string }) => s.name)
}

async function call(ctx: Context, args: Record<string, unknown>, name = 'humanize_text'): Promise<unknown> {
  return ctx.tools.execute({ callId: ToolCallId('c1'), name, arguments: args, signal: new AbortController().signal } as never)
}

async function serveRoutes(m: Mounted): Promise<string> {
  const server = createServer((req, res) => {
    const h = m.routes[m.routes.length - 1]
    if (h && req.url?.startsWith('/humanizer')) h(req, res)
    else { res.statusCode = 404; res.end('no route') }
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/humanizer/api`
}

describe('settings schema', () => {
  it('declares every field volatile with a bilingual description and the documented defaults', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta: Record<string, unknown>; dict?: Record<string, { meta: Record<string, unknown> }> }> }).dict
    for (const f of FIELDS) {
      const node = f.path.length === 2 ? dict[f.path[0]!]!.dict![f.path[1]!]! : dict[f.key]!
      expect(node.meta.volatile, f.key).toBe(true)
      expect(String(node.meta.description), f.key).toContain(' / ')
    }
    // The literal key is an ordinary secret: never served to the browser by dsh-settings.
    expect(dict.apiKey!.meta.volatile).toBeFalsy()
    expect(dict.apiKey!.meta.role).toBe('secret')
    expect(dict.apiKeyEnv!.meta.role).toBe('credential-ref')
    const s = readSettings(Config({} as never))
    expect(s).toEqual(DEFAULTS)
    expect(s.sampling).toEqual({ ...SAMPLING })
    expect(s.defaultSamples).toBe(1)
    expect(s.maxWords).toBe(350)
    expect(s.maxCjk).toBe(600)
    expect(OFFICIAL_KEYS).toEqual(['sampling.temperature', 'sampling.top_p', 'sampling.top_k', 'sampling.min_p', 'sampling.repeat_penalty', 'maxPredict'])
    expect(samplingDeviations(s)).toEqual([])
    expect(samplingDeviations(readSettings(Config({ sampling: { top_p: 0.8 } } as never)))).toEqual(['sampling.top_p'])
  })

  it('rejects invalid values server-side (the schema dsh-settings validates writes against)', () => {
    const bad: Array<Record<string, unknown>> = [
      { baseURL: 'ftp://x' }, { baseURL: 'not a url' }, { apiKeyEnv: 'bad-name' }, { defaultSamples: 0 }, { defaultSamples: 5 },
      { defaultSamples: 1.5 }, { maxCopy: 1.2 }, { maxWords: 5 }, { requestTimeoutMs: 10 }, { busyRetries: 9 },
      { sampling: { temperature: 3 } }, { sampling: { top_p: -0.1 } }, { sampling: { top_k: 0.5 } }, { maxPredict: 100 },
      { toolName: '1tool' }, { webUi: 'yes' }, { defaultKeep: 'a' },
    ]
    for (const b of bad) expect(() => Config(b as never), JSON.stringify(b)).toThrow()
    expect(() => Config({ baseURL: 'http://llm.example:18080/v1', defaultSamples: 4, defaultKeep: ['星火计划'], sampling: { temperature: 0.7 } } as never)).not.toThrow()
  })

  it('shares one validator with the browser form', () => {
    const by = new Map(FIELDS.map((f) => [f.key, f]))
    expect(checkValue(by.get('defaultSamples')!, 3)).toBeUndefined()
    expect(checkValue(by.get('defaultSamples')!, 7)).toContain('4')
    expect(checkValue(by.get('baseURL')!, 'http://h:1')).toBeUndefined()
    expect(checkValue(by.get('baseURL')!, 'h:1')).toBeDefined()
    expect(splitTerms('星火计划，用户第一\nAurora, Aurora;  ')).toEqual(['星火计划', '用户第一', 'Aurora'])
    expect(retryDelays(0)).toEqual([])
    expect(retryDelays(3)).toEqual([3000, 10000, 20000])
  })
})

describe('live apply (loader/volatile-update)', () => {
  it('applies defaults, toggles and the tool name without remounting the plugin', async () => {
    const m = await mount({ baseURL: 'http://llm.example:18080' })
    try {
      expect(toolNames(m.ctx)).toContain('humanize_text')
      await call(m.ctx, { text: EN })
      expect(m.fake.calls).toBe(1)

      commit(m.ctx, m.config, ['defaultSamples'], 3)
      m.fake.calls = 0
      const r = await call(m.ctx, { text: EN }) as { meta?: { text?: string } }
      expect(r).toBeDefined()
      expect(m.fake.calls).toBe(3)

      commit(m.ctx, m.config, ['toolName'], 'de_ai')
      await new Promise((r) => setTimeout(r, 0))
      expect(toolNames(m.ctx)).toContain('de_ai')
      expect(toolNames(m.ctx)).not.toContain('humanize_text')

      commit(m.ctx, m.config, ['toolEnabled'], false)
      await new Promise((r) => setTimeout(r, 0))
      expect(toolNames(m.ctx)).not.toContain('de_ai')

      commit(m.ctx, m.config, ['toolEnabled'], true)
      commit(m.ctx, m.config, ['defaultKeep'], ['support response'])
      await new Promise((r) => setTimeout(r, 0))
      m.fake.keep = []
      await call(m.ctx, { text: EN, n_samples: 1 }, 'de_ai')
      // A default keep term present in the draft is locked with a placeholder.
      expect(m.fake.keep.join('\n')).not.toContain('support response')
    } finally { m.restore() }
  })

  it('turns the web API on and off live', async () => {
    const m = await mount({}, { web: true })
    try {
      expect(m.routes.length).toBe(1)
      commit(m.ctx, m.config, ['webUi'], false)
      await new Promise((r) => setTimeout(r, 0))
      expect(m.routes.length).toBe(0)
      commit(m.ctx, m.config, ['webUi'], true)
      await new Promise((r) => setTimeout(r, 0))
      expect(m.routes.length).toBe(1)
    } finally { m.restore() }
  })
})

describe('settings routes', () => {
  it('report settings and key status without ever returning a key', async () => {
    const m = await mount({ baseURL: 'http://llm.example:18080', apiKeyEnv: 'HUMANIZER_TEST_API_KEY', apiKey: LITERAL, defaultSamples: 2 }, { secret: SECRET, web: true })
    try {
      const base = await serveRoutes(m)
      const res = await fetch(`${base}/settings`)
      const raw = await res.text()
      expect(res.status).toBe(200)
      expect(raw).not.toContain(SECRET)
      expect(raw).not.toContain(LITERAL)
      expect(raw).not.toContain('"apiKey"')
      const body = JSON.parse(raw) as { settings: Record<string, unknown>; key: { ref: string; configured: boolean; source?: string } }
      expect(body.settings.defaultSamples).toBe(2)
      expect(body.key).toMatchObject({ ref: 'HUMANIZER_TEST_API_KEY', configured: true, source: 'file' })

      commit(m.ctx, m.config, ['defaultSamples'], 4)
      const info = await (await fetch(`${base}/info`)).json() as { defaultSamples: number }
      expect(info.defaultSamples).toBe(4)

      const t = await fetch(`${base}/settings/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: 'http://other:1' }) })
      const tr = await t.text()
      expect(t.status).toBe(200)
      expect(tr).not.toContain(SECRET)
      expect(JSON.parse(tr)).toMatchObject({ endpoint: 'http://other:1', health: { ok: true }, auth: { ok: true } })

      const bad = await fetch(`${base}/settings/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: 'javascript:alert(1)' }) })
      expect(bad.status).toBe(400)
      const bad2 = await fetch(`${base}/settings/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKeyEnv: '../etc' }) })
      expect(bad2.status).toBe(400)
      const put = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(put.status).toBe(405)
    } finally { m.restore() }
  })

  it('UI jobs use the settings default candidate count and keep terms', async () => {
    const m = await mount({ defaultSamples: 2, defaultKeep: ['Project Aurora'] }, { web: true })
    try {
      const base = await serveRoutes(m)
      const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Furthermore, Project Aurora grew revenue by 12% while keeping costs flat, which is a remarkable achievement.' }) })
      const raw = await res.text()
      const job = /event: job\ndata: (.*)\n/.exec(raw)
      expect(job).not.toBeNull()
      const data = JSON.parse(job![1]!) as { nSamples: number; keepActive: string[] }
      expect(data.nSamples).toBe(2)
      expect(data.keepActive).toEqual(['Project Aurora'])
      expect(m.fake.calls).toBeGreaterThanOrEqual(2)
    } finally { m.restore() }
  })
})

describe('connection probe', () => {
  it('checks /health and an authenticated /tokenize, without queueing behind the slot', async () => {
    const seen: string[] = []
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      seen.push(`${req.url} ${req.headers.authorization ? 'auth' : 'anon'}`)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/health') { res.end('{"status":"ok"}'); return }
      if (req.headers.authorization !== 'Bearer good') { res.statusCode = 401; res.end('{"error":{"message":"Invalid API Key"}}'); return }
      res.end('{"tokens":[1,2,3]}')
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const good = await new LlamaServerClient({ baseURL: `${base}/v1`, apiKey: async () => 'good', requestTimeoutMs: 5000 }).probe(new AbortController().signal)
    expect(good).toMatchObject({ health: { ok: true, status: 200 }, auth: { ok: true, status: 200, tokens: 3 }, open: false })
    const bad = await new LlamaServerClient({ baseURL: base, apiKey: async () => 'wrong', requestTimeoutMs: 5000 }).probe(new AbortController().signal)
    expect(bad.auth).toMatchObject({ ok: false, status: 401, message: 'Invalid API Key' })
    expect(bad.open).toBeUndefined()
    const down = await new LlamaServerClient({ baseURL: 'http://127.0.0.1:1', apiKey: async () => 'x', requestTimeoutMs: 5000 }).probe(new AbortController().signal)
    expect(down.health.ok).toBe(false)
    expect(down.auth.ok).toBe(false)
    expect(seen).toEqual(['/health auth', '/tokenize auth', '/tokenize anon', '/health auth', '/tokenize auth'])
  })
})
