/**
 * Minimal llama-server client for the humanizer model: POST {base}/completion with the exact
 * prompt and the evaluated sampling, no stop strings (generation ends at EOS), and POST
 * {base}/tokenize to size n_predict. Mirrors hz.py's Backend (retries a dropped connection or a
 * busy/reloading engine after 3 s, 10 s, 20 s). The server runs with a single slot (-np 1), so
 * every request goes through one per-endpoint queue: samples, concurrent tool calls and UI jobs
 * run strictly one request after another. Waiting in the queue honours the caller's AbortSignal.
 * `complete` can stream (`stream: true`) to show the rewrite as it is written; the final text and
 * stop reason are the same as for the non-streaming call.
 * @module dsh-tool-humanize/client
 */
import { SAMPLING } from './prompt.ts'

export interface Sampling {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  repeat_penalty: number
}

export interface CompletionResult {
  text: string
  /** The server stopped at n_predict (stop_type "limit"): the rewrite is cut off. */
  truncated: boolean
  tokensPredicted: number | undefined
  ms: number
}

export interface HumanizerBackend {
  readonly label: string
  /** Token count of `text`, or undefined when the endpoint cannot count. */
  tokenize(text: string, signal: AbortSignal): Promise<number | undefined>
  /**
   * One sample. `onDelta`, when given, receives the text generated so far while it streams
   * (each call carries the whole text, not an increment).
   */
  complete(prompt: string, nPredict: number, signal: AbortSignal, onDelta?: (textSoFar: string) => void): Promise<CompletionResult>
  /** Reachability probe for the UI (optional). */
  health?(signal: AbortSignal): Promise<{ ok: boolean; status?: number; message?: string }>
  /** Settings-page connection test: /health plus one authenticated tiny request (optional). */
  probe?(signal: AbortSignal): Promise<ProbeResult>
}

export class HumanizerServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'HumanizerServiceError'
  }
}

/** Outcome of the settings page's 测试连接 (never carries the key). */
export interface ProbeResult {
  health: { ok: boolean; status?: number; message?: string }
  /** POST /tokenize with the configured key: 200 proves the key is accepted. */
  auth: { ok: boolean; status?: number; message?: string; ms?: number; tokens?: number }
  /** Same request without a key: true when the server does not check keys at all. */
  open?: boolean
}

/** Delays before retry 1, 2, … when the server is busy or unreachable. */
export const RETRY_SCHEDULE_MS: readonly number[] = [3000, 10000, 20000, 30000, 30000]

/** The retry delays for `n` retries (0–5). */
export function retryDelays(n: number): number[] {
  return RETRY_SCHEDULE_MS.slice(0, Math.max(0, Math.min(RETRY_SCHEDULE_MS.length, Math.trunc(n))))
}

export interface LlamaClientOptions {
  baseURL: string
  /** Resolved per request; never logged. */
  apiKey: () => Promise<string | undefined>
  requestTimeoutMs: number
  sampling?: Partial<Sampling>
  retryDelaysMs?: readonly number[]
  fetch?: typeof fetch
}

/** `http://h:p/v1/` → `http://h:p` (the completion endpoint lives at the server root). */
export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Run `task` after every earlier task for the same key settled (the -np 1 slot). When `signal`
 * aborts while the task is still waiting, the returned promise rejects at once and the task is
 * skipped when its turn comes, so a cancelled job never holds up the queue.
 */
export function serialize<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = (): Promise<T> => (signal?.aborted ? Promise.reject(signal.reason) : task())
  const next = prev.then(run, run)
  const tail = next.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  if (!signal) return next
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    next.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** Queue depth per endpoint (for the UI status line). */
export function queued(key: string): boolean {
  return queues.has(key)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(t); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errMessage(d: unknown): string {
  if (d && typeof d === 'object') {
    const e = (d as { error?: unknown }).error
    if (typeof e === 'string') return e
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  }
  return typeof d === 'string' ? d.slice(0, 200) : 'unexpected response'
}

export class LlamaServerClient implements HumanizerBackend {
  readonly base: string
  readonly label: string
  private readonly sampling: Sampling
  private readonly delays: readonly number[]
  private readonly doFetch: typeof fetch

  constructor(private readonly options: LlamaClientOptions) {
    this.base = normalizeBaseURL(options.baseURL)
    this.label = `llama-server at ${this.base}`
    this.sampling = { ...SAMPLING, ...options.sampling }
    this.delays = options.retryDelaysMs ?? retryDelays(3)
    this.doFetch = options.fetch ?? fetch
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = await this.options.apiKey()
    if (key) headers.Authorization = `Bearer ${key}`
    return headers
  }

  private post(path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; data: unknown }> {
    return serialize(this.base, async () => {
      const res = await this.doFetch(this.base + path, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
      const raw = await res.text()
      let data: unknown = raw
      try { data = JSON.parse(raw) } catch { /* non-JSON body: keep text */ }
      return { status: res.status, data }
    }, signal)
  }

  /**
   * Streaming POST /completion: parses llama-server's SSE (`data: {content, stop, ...}`) and
   * reports the accumulated text. A non-200 answer is returned like `post` for the retry logic.
   */
  private stream(body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, onDelta: (t: string) => void): Promise<{ status: number; data: unknown }> {
    return serialize(this.base, async () => {
      const res = await this.doFetch(this.base + '/completion', {
        method: 'POST',
        headers: { ...await this.headers(), Accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
      const type = res.headers.get('content-type') ?? ''
      if (res.status !== 200 || !res.body || !type.includes('event-stream')) {
        const raw = await res.text()
        let data: unknown = raw
        try { data = JSON.parse(raw) } catch { /* keep text */ }
        return { status: res.status, data }
      }
      let text = ''
      let final: Record<string, unknown> = {}
      let buf = ''
      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      const handle = (line: string): void => {
        if (!line.startsWith('data:')) return
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        let d: Record<string, unknown>
        try { d = JSON.parse(payload) as Record<string, unknown> } catch { return }
        if (typeof d.content === 'string' && d.content) { text += d.content; onDelta(text) }
        if (d.stop === true) final = d
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, nl).replace(/\r$/, ''))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf) handle(buf)
      return { status: 200, data: { ...final, content: text } }
    }, signal)
  }

  async health(signal: AbortSignal): Promise<{ ok: boolean; status?: number; message?: string }> {
    try {
      const res = await this.doFetch(this.base + '/health', {
        headers: await this.headers(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      })
      const raw = await res.text()
      let data: unknown = raw
      try { data = JSON.parse(raw) } catch { /* keep text */ }
      const st = (data as { status?: unknown } | undefined)?.status
      return { ok: res.status === 200, status: res.status, ...typeof st === 'string' ? { message: st } : {} }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  /** /health, then one authenticated POST /tokenize outside the slot queue (it needs no slot). */
  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const health = await this.health(signal)
    const tokenize = async (withKey: boolean): Promise<{ status?: number; tokens?: number; ms: number; message?: string }> => {
      const t0 = Date.now()
      try {
        const headers = withKey ? await this.headers() : { 'Content-Type': 'application/json' }
        const res = await this.doFetch(this.base + '/tokenize', {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'Hello 你好', add_special: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
        const raw = await res.text()
        let data: unknown = raw
        try { data = JSON.parse(raw) } catch { /* keep text */ }
        const tokens = (data as { tokens?: unknown } | undefined)?.tokens
        return {
          status: res.status,
          ...Array.isArray(tokens) ? { tokens: tokens.length } : {},
          ms: Date.now() - t0,
          ...res.status === 200 ? {} : { message: errMessage(data) },
        }
      } catch (error) {
        return { ms: Date.now() - t0, message: (error as Error).message }
      }
    }
    const a = await tokenize(true)
    const auth: ProbeResult['auth'] = {
      ok: a.status === 200 && a.tokens !== undefined,
      ms: a.ms,
      ...a.status !== undefined ? { status: a.status } : {},
      ...a.tokens !== undefined ? { tokens: a.tokens } : {},
      ...a.message !== undefined ? { message: a.message } : {},
    }
    const out: ProbeResult = { health, auth }
    if (auth.ok) {
      const b = await tokenize(false)
      if (b.status !== undefined) out.open = b.status === 200
    }
    return out
  }

  async tokenize(text: string, signal: AbortSignal): Promise<number | undefined> {
    try {
      const { status, data } = await this.post('/tokenize', { content: text, add_special: false }, signal, 30_000)
      const tokens = (data as { tokens?: unknown } | undefined)?.tokens
      return status === 200 && Array.isArray(tokens) ? tokens.length : undefined
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  async complete(prompt: string, nPredict: number, signal: AbortSignal, onDelta?: (textSoFar: string) => void): Promise<CompletionResult> {
    const body = { prompt, n_predict: nPredict, ...this.sampling }
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now()
      let status: number
      let data: unknown
      try {
        ({ status, data } = onDelta
          ? await this.stream(body, signal, this.options.requestTimeoutMs, onDelta)
          : await this.post('/completion', body, signal, this.options.requestTimeoutMs))
      } catch (error) {
        if (signal.aborted) throw error
        if ((error as Error).name === 'TimeoutError') {
          throw new HumanizerServiceError(`the ${this.label} did not answer within ${Math.round(this.options.requestTimeoutMs / 1000)} s`)
        }
        if (attempt < this.delays.length) { await sleep(this.delays[attempt]!, signal); continue }
        throw new HumanizerServiceError(`lost the connection to the ${this.label}: ${(error as Error).message}`)
      }
      if (status === 200 && data && typeof data === 'object' && 'content' in data) {
        const d = data as { content?: unknown; stop_type?: unknown; stopped_limit?: unknown; truncated?: unknown; tokens_predicted?: unknown }
        return {
          text: String(d.content ?? ''),
          truncated: d.stop_type === 'limit' || Boolean(d.stopped_limit) || Boolean(d.truncated),
          tokensPredicted: typeof d.tokens_predicted === 'number' ? d.tokens_predicted : undefined,
          ms: Date.now() - t0,
        }
      }
      if ((status === 502 || status === 503) && attempt < this.delays.length) { await sleep(this.delays[attempt]!, signal); continue }
      if (status === 401 || status === 403) throw new HumanizerServiceError(`the ${this.label} rejected the API key (HTTP ${status}); check the credential reference in the tool-humanize config`, status)
      throw new HumanizerServiceError(`the ${this.label} answered HTTP ${status}: ${errMessage(data)}`, status)
    }
  }
}
