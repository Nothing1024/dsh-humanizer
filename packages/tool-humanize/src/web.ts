/**
 * Host half of the interactive UI: a `/humanizer/api/*` route family on the dsh web server
 * (same origin as the dsh web app, guarded by the dsh browser session — `connection.requestRejection`,
 * the way vibee-viz guards `/vibee`). Every model call goes through the engine in ./engine.ts
 * (keep locks, hz chunking, language guard, checks, retries) and the per-endpoint queue in
 * ./client.ts; the browser only renders.
 *
 *   GET  /humanizer/api/info                          limits + endpoint label (no secrets)
 *   GET  /humanizer/api/health                        llama-server /health through the plugin
 *   POST /humanizer/api/jobs                          {text, keep?, n_samples?} → SSE stream
 *   GET  /humanizer/api/jobs/:id                      snapshot of a job
 *   POST /humanizer/api/jobs/:id/units/:uid/regenerate  {n_samples?} → SSE stream (one piece)
 *   POST /humanizer/api/jobs/:id/choose               {unitId, index} → document + warnings
 *   POST /humanizer/api/jobs/:id/cancel               stop the running stream
 *   POST /humanizer/api/import?name=a.docx            raw .docx body → {text}
 *   GET  /humanizer/api/settings                      effective settings + key status (never the key)
 *   POST /humanizer/api/settings/test                 {baseURL?, apiKeyEnv?} → /health + authenticated probe
 *
 * Settings are edited and persisted through dsh's own settings service (Plugins page / the panel's
 * 设置 view), not through this API; the two settings routes only read and probe.
 *
 * SSE events: job, unit, sample, partial, candidate, piece, document, done, error. Closing the
 * stream (browser fetch aborted) cancels the job's running work.
 * @module dsh-tool-humanize/web
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HumanizerBackend } from './client.ts'
import { DocxError, docxToText } from './docx.ts'
import {
  assembleDocument, clampSamples, documentWarnings, planDocument, rewriteUnit,
} from './engine.ts'
import type { Candidate, DocumentPlan, PieceReport } from './engine.ts'

export const ROUTE_PREFIX = '/humanizer'

export interface WebLimits {
  maxChars: number
  maxWords: number
  maxCjk: number
  maxCopy: number
  retries: number
  maxPredict: number
  baseURL: string
  toolName: string
  /** Candidates per piece when a request does not say (1–4). */
  defaultSamples?: number
  /** Terms always kept verbatim when present in the draft. */
  defaultKeep?: readonly string[]
  langRetries?: number
  factTries?: number
}

/** Read/probe face of the settings for the two settings routes. */
export interface WebSettings {
  /** Effective settings and key status; must never include a key value. */
  describe(): Promise<Record<string, unknown>>
  /** Connection test, optionally against staged (unsaved) baseURL / apiKeyEnv values. */
  test(overrides: { baseURL?: string; apiKeyEnv?: string }, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface WebDeps {
  /** Current limits; a function is read per request, so settings changes apply to the next job. */
  limits: WebLimits | (() => WebLimits)
  settings?: WebSettings
  /** A backend for one job (the key is resolved per request inside it). */
  backend: () => HumanizerBackend
  /** HTTP status to reject with, or undefined when the request carries a valid dsh session. */
  authorize: (req: IncomingMessage) => number | undefined
  /** Max jobs kept in memory (oldest dropped first). */
  maxJobs?: number
  /** Idle job lifetime (ms). */
  jobTtlMs?: number
  /** Minimum gap between two `partial` frames of one sample (ms). */
  partialEveryMs?: number
  logger?: { warn(message: string): void }
}

export interface WireCandidate {
  text: string
  copyRate: number
  issues: string[]
  missingNumbers: string[]
  addedNumbers: string[]
  missingUrls: string[]
  languageResampled: number
  keepTries: number
  seconds: number
}

export interface WirePiece {
  id: number
  kind: string
  line: number
  draft: string
  words: number
  candidates: WireCandidate[]
  /** The engine's pick (best by checks). */
  best: number
  /** The user's current pick. */
  chosen: number
  seconds: number
}

interface Job {
  id: string
  doc: DocumentPlan
  nSamples: number
  pieces: Map<number, PieceReport>
  choices: Map<number, number>
  controller: AbortController | undefined
  touched: number
  requests: number
  seconds: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export function wireCandidate(c: Candidate): WireCandidate {
  return {
    text: c.text,
    copyRate: Math.round(c.copyRate * 1000) / 1000,
    issues: [...c.issues],
    missingNumbers: c.missingNumbers,
    addedNumbers: c.addedNumbers,
    missingUrls: c.missingUrls,
    languageResampled: c.languageResampled,
    keepTries: c.keepTries,
    seconds: round1(c.seconds),
  }
}

function wirePiece(p: PieceReport, chosen: number): WirePiece {
  return {
    id: p.id, kind: p.kind, line: p.line, draft: p.draft, words: p.words,
    candidates: p.candidates.map(wireCandidate),
    best: p.chosen, chosen, seconds: round1(p.seconds),
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += b.length
    if (size > limit) throw new HttpError(413, `请求太大（上限 ${Math.round(limit / 1024)} KB）`)
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, limit)).toString('utf8').trim()
  if (!raw) return {}
  let v: unknown
  try { v = JSON.parse(raw) } catch { throw new HttpError(400, '请求体不是 JSON') }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return v as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  res.end(payload)
}

interface Sse {
  send(event: string, data: unknown): void
  end(): void
  closed(): boolean
}

function openSse(res: ServerResponse, onClose: () => void): Sse {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  let closed = false
  const heartbeat = setInterval(() => { if (!closed) res.write(': hb\n\n') }, 15_000)
  res.on('close', () => {
    clearInterval(heartbeat)
    if (!closed) { closed = true; onClose() }
  })
  return {
    send(event, data) {
      if (closed) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    end() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      res.end()
    },
    closed: () => closed,
  }
}

function keepList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((k): k is string => typeof k === 'string' && k.trim() !== '').slice(0, 50)
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

/** The route family as one prefix handler (see module doc). */
export class HumanizerWeb {
  private readonly jobs = new Map<string, Job>()
  private readonly maxJobs: number
  private readonly ttl: number
  private readonly partialEvery: number

  private limits(): WebLimits {
    const l: WebLimits | (() => WebLimits) = this.deps.limits
    return typeof l === 'function' ? l() : l
  }

  constructor(private readonly deps: WebDeps) {
    this.maxJobs = deps.maxJobs ?? 30
    this.ttl = deps.jobTtlMs ?? 2 * 60 * 60 * 1000
    this.partialEvery = deps.partialEveryMs ?? 120
  }

  /** Abort everything (plugin disposal). */
  dispose(): void {
    for (const job of this.jobs.values()) job.controller?.abort(new Error('disposed'))
    this.jobs.clear()
  }

  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    const rejection = this.deps.authorize(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: rejection === 401 ? '需要 dsh 登录会话（请从 dsh web 页面打开）' : '请求被拒绝' })
      return
    }
    void this.route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, status, { ok: false, error: message })
      else res.end()
    })
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '')
    const method = req.method ?? 'GET'
    let m: RegExpExecArray | null
    if (method === 'GET' && path === '/api/info') return this.info(res)
    if (method === 'GET' && path === '/api/health') return this.health(res)
    if (method === 'POST' && path === '/api/jobs') return this.create(req, res)
    if (method === 'GET' && path === '/api/settings') return this.settingsInfo(res)
    if (method === 'POST' && path === '/api/settings/test') return this.settingsTest(req, res)
    if (path === '/api/settings') throw new HttpError(405, '设置请在 dsh「插件」页或面板的「设置」里修改（由 dsh 设置服务保存）')
    if (method === 'POST' && path === '/api/import') return this.importFile(req, res, url.searchParams.get('name') ?? '')
    if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(path)) && method === 'GET') return this.snapshot(res, m[1]!)
    if ((m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(path)) && method === 'POST') return this.cancel(res, m[1]!)
    if ((m = /^\/api\/jobs\/([\w-]+)\/choose$/.exec(path)) && method === 'POST') return this.choose(req, res, m[1]!)
    if ((m = /^\/api\/jobs\/([\w-]+)\/units\/(\d+)\/regenerate$/.exec(path)) && method === 'POST') return this.regenerate(req, res, m[1]!, Number(m[2]))
    throw new HttpError(404, `没有这个接口：${method} ${url.pathname}`)
  }

  private info(res: ServerResponse): void {
    const l = this.limits()
    let endpoint = l.baseURL
    try { const u = new URL(l.baseURL); endpoint = `${u.protocol}//${u.host}` } catch { /* keep */ }
    sendJson(res, 200, {
      ok: true,
      endpoint,
      toolName: l.toolName,
      maxChars: l.maxChars,
      maxWords: l.maxWords,
      maxCjk: l.maxCjk,
      maxCopy: l.maxCopy,
      maxSamples: 4,
      defaultSamples: clampSamples(l.defaultSamples ?? 1),
      defaultKeep: [...l.defaultKeep ?? []],
      jobs: this.jobs.size,
    })
  }

  private async settingsInfo(res: ServerResponse): Promise<void> {
    if (!this.deps.settings) throw new HttpError(404, '设置接口不可用')
    sendJson(res, 200, { ok: true, ...await this.deps.settings.describe() })
  }

  private async settingsTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.settings) throw new HttpError(404, '设置接口不可用')
    const body = await readJson(req, 16 * 1024)
    const overrides: { baseURL?: string; apiKeyEnv?: string } = {}
    if (body.baseURL !== undefined && body.baseURL !== '') {
      if (typeof body.baseURL !== 'string' || !/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(body.baseURL)) throw new HttpError(400, '服务地址格式不对（需要 http:// 或 https:// 开头）')
      overrides.baseURL = body.baseURL
    }
    if (body.apiKeyEnv !== undefined && body.apiKeyEnv !== '') {
      if (typeof body.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.apiKeyEnv)) throw new HttpError(400, '密钥引用名格式不对（字母、数字、下划线）')
      overrides.apiKeyEnv = body.apiKeyEnv
    }
    const signal = AbortSignal.timeout(30_000)
    sendJson(res, 200, { ok: true, ...await this.deps.settings.test(overrides, signal) })
  }

  private async health(res: ServerResponse): Promise<void> {
    const backend = this.deps.backend()
    const signal = AbortSignal.timeout(8000)
    const h = backend.health ? await backend.health(signal) : { ok: true, message: 'no probe' }
    sendJson(res, 200, { ok: true, health: h })
  }

  private job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new HttpError(404, '任务不存在或已过期，请重新改写')
    job.touched = Date.now()
    return job
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (!job.controller && now - job.touched > this.ttl) this.jobs.delete(id)
    }
    const idle = [...this.jobs.values()].filter((j) => !j.controller).sort((a, b) => a.touched - b.touched)
    while (this.jobs.size >= this.maxJobs && idle.length > 0) this.jobs.delete(idle.shift()!.id)
  }

  private pieceList(job: Job): PieceReport[] {
    return job.doc.plan.units.flatMap((u) => {
      const p = job.pieces.get(u.id)
      return p ? [{ ...p, chosen: job.choices.get(u.id) ?? p.chosen }] : []
    })
  }

  private documentOf(job: Job): { text: string; warnings: string[]; done: number; total: number } {
    const text = assembleDocument(job.doc, (id) => {
      const p = job.pieces.get(id)
      return p ? p.candidates[job.choices.get(id) ?? p.chosen]?.text ?? p.candidates[p.chosen]!.text : undefined
    })
    return { text, warnings: documentWarnings(job.doc, this.pieceList(job)), done: job.pieces.size, total: job.doc.units.length }
  }

  private snapshotOf(job: Job): unknown {
    return {
      jobId: job.id,
      nSamples: job.nSamples,
      running: job.controller !== undefined,
      units: job.doc.units,
      keepActive: job.doc.keepActive,
      keepIgnored: job.doc.keepIgnored,
      kept: job.doc.kept,
      pieces: this.pieceList(job).map((p) => wirePiece(job.pieces.get(p.id)!, p.chosen)),
      document: this.documentOf(job),
      requests: job.requests,
      seconds: round1(job.seconds),
    }
  }

  private snapshot(res: ServerResponse, id: string): void {
    sendJson(res, 200, { ok: true, job: this.snapshotOf(this.job(id)) })
  }

  private cancel(res: ServerResponse, id: string): void {
    const job = this.job(id)
    job.controller?.abort(new DOMException('stopped', 'AbortError'))
    sendJson(res, 200, { ok: true })
  }

  private async choose(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const job = this.job(id)
    const body = await readJson(req, 64 * 1024)
    const unitId = Number(body.unitId)
    const index = Number(body.index)
    const p = job.pieces.get(unitId)
    if (!p) throw new HttpError(404, '这一段还没有改写结果')
    if (!Number.isInteger(index) || index < 0 || index >= p.candidates.length) throw new HttpError(400, '候选编号无效')
    job.choices.set(unitId, index)
    sendJson(res, 200, { ok: true, document: this.documentOf(job) })
  }

  private async importFile(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const buf = await readBody(req, 20 * 1024 * 1024)
    const lower = name.toLowerCase()
    let text: string
    if (lower.endsWith('.docx')) {
      try { text = docxToText(buf) } catch (error) {
        throw new HttpError(400, error instanceof DocxError ? error.message : `无法读取 .docx：${(error as Error).message}`)
      }
    } else if (/\.(txt|md|markdown|text)$/.test(lower) || lower === '') {
      text = buf.toString('utf8').replace(/^\uFEFF/, '')
    } else {
      throw new HttpError(415, '只支持 .txt / .md / .docx')
    }
    if (!text.trim()) throw new HttpError(400, '文件里没有可改写的文字')
    sendJson(res, 200, { ok: true, text, chars: Array.from(text).length })
  }

  private async create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const l = this.limits()
    const body = await readJson(req, Math.max(256 * 1024, l.maxChars * 8))
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) throw new HttpError(400, '草稿是空的')
    const chars = Array.from(text).length
    if (chars > l.maxChars) throw new HttpError(413, `草稿 ${chars} 字符，超过上限 ${l.maxChars}；请分开改写`)
    this.prune()
    const keep = [...(l.defaultKeep ?? []).filter((k) => k && text.includes(k)), ...keepList(body.keep)]
    const doc = planDocument(text, { keep: [...new Set(keep)].slice(0, 50), maxWords: l.maxWords, maxCjk: l.maxCjk })
    const job: Job = {
      id: randomUUID(),
      doc,
      nSamples: clampSamples(body.n_samples ?? l.defaultSamples),
      pieces: new Map(),
      choices: new Map(),
      controller: undefined,
      touched: Date.now(),
      requests: 0,
      seconds: 0,
    }
    this.jobs.set(job.id, job)
    await this.stream(res, job, doc.units.map((u) => u.id), job.nSamples, true)
  }

  private async regenerate(req: IncomingMessage, res: ServerResponse, id: string, unitId: number): Promise<void> {
    const job = this.job(id)
    const body = await readJson(req, 64 * 1024)
    if (job.controller) throw new HttpError(409, '这个任务还在改写中，请先等它完成或停止')
    if (!job.doc.units.some((u) => u.id === unitId)) throw new HttpError(404, '没有这一段')
    const n = body.n_samples === undefined ? job.nSamples : clampSamples(body.n_samples)
    await this.stream(res, job, [unitId], n, false)
  }

  /** Rewrite `unitIds` in order, streaming progress; the job keeps whatever finished. */
  private async stream(res: ServerResponse, job: Job, unitIds: number[], nSamples: number, announce: boolean): Promise<void> {
    const controller = new AbortController()
    job.controller = controller
    const sse = openSse(res, () => controller.abort(new DOMException('client closed', 'AbortError')))
    const l = this.limits()
    const t0 = Date.now()
    const counter = { requests: 0 }
    if (announce) {
      sse.send('job', {
        jobId: job.id, nSamples: job.nSamples, units: job.doc.units,
        keepActive: job.doc.keepActive, keepIgnored: job.doc.keepIgnored, kept: job.doc.kept,
        document: this.documentOf(job),
      })
    }
    const backend = this.deps.backend()
    let cancelled = false
    try {
      for (const [pos, unitId] of unitIds.entries()) {
        if (controller.signal.aborted) { cancelled = true; break }
        sse.send('unit', { unitId, state: 'running', position: pos, count: unitIds.length })
        let lastPartial = 0
        const piece = await rewriteUnit(job.doc, unitId, backend, {
          nSamples,
          maxCopy: l.maxCopy,
          retries: l.retries,
          maxWords: l.maxWords,
          maxCjk: l.maxCjk,
          maxPredict: l.maxPredict,
          ...l.langRetries !== undefined ? { langRetries: l.langRetries } : {},
          ...l.factTries !== undefined ? { factTries: l.factTries } : {},
          signal: controller.signal,
          counter,
          hooks: {
            onSampleStart: (index) => { lastPartial = 0; sse.send('sample', { unitId, index }) },
            onPartial: (index, text) => {
              const now = Date.now()
              if (now - lastPartial < this.partialEvery) return
              lastPartial = now
              sse.send('partial', { unitId, index, text })
            },
            onCandidate: (index, c) => { sse.send('candidate', { unitId, index, candidate: wireCandidate(c) }) },
          },
        })
        job.pieces.set(unitId, piece)
        job.choices.set(unitId, piece.chosen)
        sse.send('piece', { unitId, piece: wirePiece(piece, piece.chosen) })
        sse.send('document', this.documentOf(job))
      }
    } catch (error) {
      if (isAbort(error, controller.signal)) cancelled = true
      else {
        this.deps.logger?.warn(`humanizer ui: ${(error as Error).message}`)
        sse.send('error', { message: (error as Error).message })
      }
    } finally {
      job.controller = undefined
      job.requests += counter.requests
      job.seconds += (Date.now() - t0) / 1000
      job.touched = Date.now()
    }
    const doc = this.documentOf(job)
    sse.send('done', { ...doc, cancelled, requests: counter.requests, seconds: round1((Date.now() - t0) / 1000) })
    sse.end()
  }
}
