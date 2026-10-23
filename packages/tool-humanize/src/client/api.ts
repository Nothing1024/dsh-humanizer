/**
 * Browser → host calls for the UI. Same origin as dsh web, so the dsh session cookie
 * authenticates every request; no token handling here. Streams are SSE over a POST fetch.
 */
export const API = '/humanizer/api'

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
  best: number
  chosen: number
  seconds: number
}

export interface WireUnit { id: number; kind: string; line: number; draft: string }

export interface WireDocument { text: string; warnings: string[]; done: number; total: number }

export interface Info {
  endpoint: string
  toolName: string
  maxChars: number
  maxWords: number
  maxCjk: number
  maxCopy: number
  maxSamples: number
  /** Settings defaults (absent on older hosts). */
  defaultSamples?: number
  defaultKeep?: string[]
}

export type StreamEvent =
  | { event: 'job'; data: { jobId: string; nSamples: number; units: WireUnit[]; keepActive: string[]; keepIgnored: string[]; kept: Record<string, number>; document: WireDocument } }
  | { event: 'unit'; data: { unitId: number; state: 'running'; position: number; count: number } }
  | { event: 'sample'; data: { unitId: number; index: number } }
  | { event: 'partial'; data: { unitId: number; index: number; text: string } }
  | { event: 'candidate'; data: { unitId: number; index: number; candidate: WireCandidate } }
  | { event: 'piece'; data: { unitId: number; piece: WirePiece } }
  | { event: 'document'; data: WireDocument }
  | { event: 'done'; data: WireDocument & { cancelled: boolean; requests: number; seconds: number } }
  | { event: 'error'; data: { message: string } }

async function errorOf(res: Response): Promise<string> {
  try {
    const j = await res.json() as { error?: unknown }
    if (typeof j.error === 'string') return j.error
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(await errorOf(res))
  return await res.json() as T
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorOf(res))
  return await res.json() as T
}

/** Parse an SSE byte stream into events (exported for tests). */
export function sseParser(onEvent: (e: StreamEvent) => void): { push(chunk: string): void; end(): void } {
  let buf = ''
  const flush = (block: string): void => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length) return
    try { onEvent({ event, data: JSON.parse(data.join('\n')) } as StreamEvent) } catch { /* malformed frame */ }
  }
  return {
    push(chunk) {
      buf += chunk.replace(/\r\n/g, '\n')
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        flush(buf.slice(0, i))
        buf = buf.slice(i + 2)
      }
    },
    end() { if (buf.trim()) flush(buf); buf = '' },
  }
}

export async function postStream(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(API + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await errorOf(res))
  const parser = sseParser(onEvent)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.end()
}

export async function importFile(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (/\.(txt|md|markdown|text)$/.test(name)) return (await file.text()).replace(/^\uFEFF/, '')
  if (!name.endsWith('.docx')) throw new Error('只支持 .txt / .md / .docx')
  const res = await fetch(`${API}/import?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw new Error(await errorOf(res))
  return (await res.json() as { text: string }).text
}
