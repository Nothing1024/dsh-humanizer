import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { HumanizerWeb } from '../src/web.ts'
import type { WebDeps } from '../src/web.ts'
import type { CompletionResult, HumanizerBackend } from '../src/client.ts'
import { sseParser } from '../src/client/api.ts'
import type { StreamEvent } from '../src/client/api.ts'
import { docxToText } from '../src/docx.ts'
import { INSTR, SEP } from '../src/prompt.ts'
import * as toolHumanize from '../src/index.ts'

const EN1 = 'Our team shipped 3 releases in 2026 and support response times dropped to 4 hours across all regions.'
const EN2 = 'Furthermore, Project Aurora grew revenue by 12% while keeping costs flat, which is a remarkable achievement.'

/** Rewrites each draft deterministically; sample k gets a different wording. */
class Fake implements HumanizerBackend {
  readonly label = 'fake'
  calls = 0
  prompts: string[] = []
  delayMs = 2
  constructor(private readonly reply: (draft: string, call: number) => string = (d, c) => `Version ${c}: ${d.replace(/Furthermore, /, '').replace(/across all regions/, 'everywhere')}`) {}
  async tokenize(t: string): Promise<number> { return Math.ceil(t.length / 4) }
  async complete(prompt: string, _n: number, signal: AbortSignal, onDelta?: (t: string) => void): Promise<CompletionResult> {
    this.calls++
    this.prompts.push(prompt)
    const draft = prompt.slice(INSTR.length + 2, -SEP.length)
    const text = this.reply(draft, this.calls)
    if (onDelta) { onDelta(text.slice(0, 5)); onDelta(text) }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs)
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
    })
    return { text, truncated: false, tokensPredicted: 10, ms: 1 }
  }
  async health(): Promise<{ ok: boolean }> { return { ok: true } }
}

const LIMITS: WebDeps['limits'] = { maxChars: 20000, maxWords: 350, maxCjk: 600, maxCopy: 0.5, retries: 1, maxPredict: 2048, baseURL: 'http://llm.example:18080', toolName: 'humanize_text' }

let servers: Server[] = []
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  servers = []
})

async function serve(fake: Fake, extra: Partial<WebDeps> = {}): Promise<{ base: string; web: HumanizerWeb }> {
  const web = new HumanizerWeb({ limits: LIMITS, backend: () => fake, authorize: () => undefined, partialEveryMs: 0, ...extra })
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/humanizer')) web.handle(req, res)
    else { res.statusCode = 404; res.end() }
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/humanizer/api`, web }
}

async function stream(url: string, body: unknown, signal?: AbortSignal): Promise<StreamEvent[]> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...signal ? { signal } : {} })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const events: StreamEvent[] = []
  const p = sseParser((e) => events.push(e))
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    p.push(dec.decode(value, { stream: true }))
  }
  p.end()
  return events
}

type DataOf<K extends StreamEvent['event']> = Extract<StreamEvent, { event: K }>['data']
const of = <K extends StreamEvent['event']>(events: StreamEvent[], k: K): Array<DataOf<K>> =>
  events.filter((e) => e.event === k).map((e) => e.data as unknown as DataOf<K>)

describe('UI API (/humanizer/api)', () => {
  it('streams a job piece by piece with n candidates, partial text and keep locks', async () => {
    const fake = new Fake()
    const { base } = await serve(fake)
    const text = `# Report\n\n${EN1}\n\n${EN2}`
    const events = await stream(`${base}/jobs`, { text, keep: ['Project Aurora', 'not in draft'], n_samples: 2 })
    const kinds = events.map((e) => e.event)
    expect(kinds[0]).toBe('job')
    expect(kinds.at(-1)).toBe('done')
    const job = of(events, 'job')[0]!
    expect(job.units.length).toBeGreaterThanOrEqual(1)
    expect(job.keepActive).toEqual(['Project Aurora'])
    expect(job.keepIgnored).toEqual(['not in draft'])
    // the model never sees the kept term, only its placeholder
    expect(fake.prompts.join('\n')).not.toContain('Project Aurora')
    expect(fake.prompts.join('\n')).toContain('[[HZ_LOCK_0]]')
    const pieces = of(events, 'piece')
    expect(pieces).toHaveLength(job.units.length)
    for (const p of pieces) expect(p.piece.candidates.length).toBeGreaterThanOrEqual(2)
    expect(of(events, 'partial').length).toBeGreaterThan(0)
    expect(of(events, 'candidate').length).toBeGreaterThanOrEqual(2 * job.units.length)
    const done = of(events, 'done')[0]!
    expect(done.cancelled).toBe(false)
    expect(done.text.startsWith('# Report\n\n')).toBe(true)
    expect(done.text).toContain('Project Aurora')
    expect(done.text).toContain('Version')
    expect(done.done).toBe(done.total)
    expect(done.warnings.join('\n')).toContain('not in draft')
  })

  it('switches candidates, regenerates one piece and reports a snapshot', async () => {
    const fake = new Fake()
    const { base } = await serve(fake)
    const events = await stream(`${base}/jobs`, { text: EN1, n_samples: 2 })
    const { jobId, units } = of(events, 'job')[0]!
    const unitId = units[0]!.id
    const piece = of(events, 'piece')[0]!.piece
    const other = piece.chosen === 0 ? 1 : 0
    const chosen = await (await fetch(`${base}/jobs/${jobId}/choose`, { method: 'POST', body: JSON.stringify({ unitId, index: other }) })).json() as { document: { text: string } }
    expect(chosen.document.text).toBe(piece.candidates[other]!.text)
    const bad = await fetch(`${base}/jobs/${jobId}/choose`, { method: 'POST', body: JSON.stringify({ unitId, index: 9 }) })
    expect(bad.status).toBe(400)

    const before = fake.calls
    const regen = await stream(`${base}/jobs/${jobId}/units/${unitId}/regenerate`, { n_samples: 3 })
    expect(of(regen, 'job')).toHaveLength(0)
    expect(of(regen, 'piece')[0]!.piece.candidates.length).toBeGreaterThanOrEqual(3)
    expect(fake.calls - before).toBeGreaterThanOrEqual(3)
    const snap = await (await fetch(`${base}/jobs/${jobId}`)).json() as { job: { pieces: Array<{ candidates: unknown[] }>; running: boolean } }
    expect(snap.job.running).toBe(false)
    expect(snap.job.pieces[0]!.candidates.length).toBeGreaterThanOrEqual(3)
    expect((await fetch(`${base}/jobs/nope`)).status).toBe(404)
  })

  it('cancels the running work when the browser closes the stream', async () => {
    const fake = new Fake()
    fake.delayMs = 200
    const { base } = await serve(fake)
    const ctl = new AbortController()
    const text = Array.from({ length: 6 }, (_, i) => `${EN1.replace('3', String(i + 3))} Paragraph ${i}.`).join('\n\n')
    const p = stream(`${base}/jobs`, { text }, ctl.signal).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 120))
    ctl.abort()
    await p
    const callsAtAbort = fake.calls
    await new Promise((r) => setTimeout(r, 500))
    expect(fake.calls).toBe(callsAtAbort)
    expect(fake.calls).toBeLessThan(6)
  })

  it('rejects requests without a dsh session and validates input', async () => {
    const { base } = await serve(new Fake(), { authorize: () => 401 })
    const r = await fetch(`${base}/info`)
    expect(r.status).toBe(401)
    const { base: b2 } = await serve(new Fake())
    expect((await fetch(`${b2}/jobs`, { method: 'POST', body: '{"text":"  "}' })).status).toBe(400)
    expect((await fetch(`${b2}/jobs`, { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(20001) }) })).status).toBe(413)
    expect((await fetch(`${b2}/nothing`)).status).toBe(404)
    const info = await (await fetch(`${b2}/info`)).json() as Record<string, unknown>
    expect(info.endpoint).toBe('http://llm.example:18080')
    expect(JSON.stringify(info)).not.toMatch(/key/i)
    const h = await (await fetch(`${b2}/health`)).json() as { health: { ok: boolean } }
    expect(h.health.ok).toBe(true)
  })

  it('imports .txt and .docx drafts', async () => {
    const { base } = await serve(new Fake())
    const txt = await (await fetch(`${base}/import?name=a.md`, { method: 'POST', body: '\uFEFF# T\n\nhello' })).json() as { text: string }
    expect(txt.text).toBe('# T\n\nhello')
    const docx = makeDocx(DOC_XML)
    const r = await (await fetch(`${base}/import?name=a.docx`, { method: 'POST', body: new Uint8Array(docx) })).json() as { text: string }
    expect(r.text).toBe('# 标题\n\n第一段 & 文字\t制表\n\n- 项目一\n- 项目二\n\nA | B')
    expect((await fetch(`${base}/import?name=a.pdf`, { method: 'POST', body: 'x' })).status).toBe(415)
    expect((await fetch(`${base}/import?name=a.docx`, { method: 'POST', body: 'not a zip' })).status).toBe(400)
  })

  it('mounts /humanizer on the web server and fails closed without the connection guard', async () => {
    const ctx = new Context()
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = []
    ;(ctx as unknown as { provide(n: string): void }).provide('webServer')
    ctx.set('webServer' as never, { register: (r: { path: string; handler: () => void }) => { routes.push(r); return () => {} } } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(toolHumanize, {})
    await new Promise((r) => setTimeout(r, 10))
    expect(routes.map((r) => r.path)).toEqual(['/humanizer'])
    const server = createServer((req, res) => routes[0]!.handler(req, res))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/humanizer/api/info`)
    expect(res.status).toBe(503)
  })
})

const DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">第一段 &amp; </w:t></w:r><w:r><w:t>文字</w:t><w:tab/><w:t>制表</w:t></w:r></w:p>
<w:p/>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>项目一</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>项目二</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`

/** Minimal zip writer (deflate) for the docx fixture. */
function makeDocx(xml: string): Buffer {
  const files = [{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from(xml) }]
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const comp = deflateRawSync(f.data)
    const name = Buffer.from(f.name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

describe('docx import', () => {
  it('reads headings, paragraphs, lists and tables', () => {
    expect(docxToText(makeDocx(DOC_XML))).toContain('# 标题')
  })
})
