/**
 * The rewrite loop — port of hz.py rewrite_units() plus the app's guards:
 *  1. keep-verbatim spans become placeholders over the whole document (atomic for the planner);
 *  2. the document is planned with hz_text's planner (Markdown kept, ~350 words / 600 汉字 pieces);
 *  3. each piece is sampled `nSamples` times, strictly sequentially (the server has one slot);
 *     every sample gets the language guard (silent resample, up to 3×) inside the keep guard
 *     (placeholders must all come back once, up to 3 tries);
 *  4. each sample is checked (numbers, links, copy rate > 0.5, length, repetition, markup); when
 *     every sample still has a retryable problem, one more is drawn (hz --retries 1) and the
 *     version with the lowest hz score is kept.
 * @module dsh-tool-humanize/engine
 */
import { FACT_TRIES, FactsLostError, locksIn, protectFacts, restoreFacts } from './facts.ts'
import type { ProtectedDraft } from './facts.ts'
import { buildPrompt, estimateTokens, nPredictFor, pyStrip } from './prompt.ts'
import type { HumanizerBackend } from './client.ts'
import {
  LANG_RETRIES, MAX_COPY, MAX_CJK, MAX_WORDS, check, cjkChars, compareScore, countWords,
  languageDrift, latinWords, plan, render, shouldRetry, Sizer,
} from './text.ts'
import type { Check, Issue, Plan, Unit } from './text.ts'

export interface HumanizeOptions {
  nSamples?: number
  keep?: readonly string[]
  maxCopy?: number
  /** Extra tries when every sample of a piece has a problem (hz default 1). */
  retries?: number
  langRetries?: number
  factTries?: number
  maxWords?: number
  maxCjk?: number
  maxPredict?: number
  signal: AbortSignal
}

export type CandidateIssue = Issue | 'keep_failed'

export interface Candidate {
  text: string
  copyRate: number
  issues: CandidateIssue[]
  missingNumbers: string[]
  addedNumbers: string[]
  missingUrls: string[]
  truncated: boolean
  languageResampled: number
  keepTries: number
  seconds: number
}

export interface PieceReport {
  id: number
  kind: Unit['kind']
  line: number
  draft: string
  words: number
  candidates: Candidate[]
  /** Index into candidates of the version used in `text`. */
  chosen: number
  seconds: number
}

export interface HumanizeResult {
  text: string
  /** Full documents built from sample k of every piece (only when nSamples > 1). */
  variants: string[]
  pieces: PieceReport[]
  kept: Record<string, number>
  warnings: string[]
  keepActive: string[]
  keepIgnored: string[]
  nSamples: number
  requests: number
  seconds: number
}

const KEEP_FAILED_WEIGHT = 500

function candidateScore(c: Candidate): [number, number] {
  return c.issues.includes('keep_failed') ? [KEEP_FAILED_WEIGHT, 1] : [0, 0]
}

function asCheck(c: Candidate): Check {
  return { copy: c.copyRate, missingNumbers: c.missingNumbers, missingUrls: c.missingUrls, addedNumbers: c.addedNumbers, issues: c.issues.filter((i): i is Issue => i !== 'keep_failed') }
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  const ka = candidateScore(a)[0]
  const kb = candidateScore(b)[0]
  return ka - kb || compareScore(asCheck(a), asCheck(b))
}

export function clampSamples(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 1
  return Math.min(4, Math.max(1, v))
}

function where(p: PieceReport, total: number): string {
  return total > 1 ? `第 ${p.id}/${total} 段（原文第 ${p.line} 行）` : '全文'
}

/** Human-readable warnings (Chinese; the caller is a Chinese-speaking user) for the kept versions. */
export function describeWarnings(pieces: PieceReport[]): string[] {
  const out: string[] = []
  for (const p of pieces) {
    const c = p.candidates[p.chosen]
    if (!c) continue
    const w = where(p, pieces.length)
    const parts: string[] = []
    if (c.issues.includes('keep_failed')) parts.push('要求原样保留的文字在改写中丢失/被改，已退回这段原文（未改写）')
    if (c.issues.includes('empty')) parts.push('改写为空')
    if (c.issues.includes('truncated')) parts.push('改写被截断（达到 n_predict 上限）')
    if (c.issues.includes('too_short')) parts.push('改写比原文短很多，可能漏了内容')
    if (c.issues.includes('too_long')) parts.push('改写比原文长很多，可能添了内容')
    if (c.issues.includes('language')) parts.push('改写语言和原文不一致（已自动重采仍未纠正）')
    if (c.issues.includes('repeated')) parts.push('改写里有两句意思重复')
    if (c.issues.includes('markup')) parts.push('改写里出现原文没有的 HTML 标签')
    if (c.missingNumbers.length > 0) parts.push(`改写里找不到这些数字：${c.missingNumbers.join('、')}`)
    if (c.missingUrls.length > 0) parts.push(`改写里找不到这些链接：${c.missingUrls.join('、')}`)
    if (c.issues.includes('copy')) parts.push(`照抄率 ${(c.copyRate * 100).toFixed(0)}%（> ${(MAX_COPY * 100).toFixed(0)}%）`)
    if (c.addedNumbers.length > 0) parts.push(`改写里出现原文没有的数字：${c.addedNumbers.join('、')}（确认不是编造）`)
    if (parts.length > 0) out.push(`${w}：${parts.join('；')}`)
  }
  return out
}

interface SampleContext {
  backend: HumanizerBackend
  pd: ProtectedDraft
  unit: Unit
  draft: string
  nPredict: number
  langRetries: number
  factTries: number
  maxCopy: number
  sizer: Sizer
  signal: AbortSignal
  counter: { requests: number }
  /** Live text of the request in flight (placeholders shown as the kept text). */
  onPartial?: ((text: string) => void) | undefined
}

async function sampleOnce(sc: SampleContext): Promise<Candidate> {
  const locks = locksIn(sc.unit.text, sc.pd)
  const prompt = buildPrompt(sc.unit.text)
  // Kept literals do not count towards the language (a kept Chinese name is not Chinese prose).
  const kept = locks.map((l) => l.value)
  const t0 = Date.now()
  let languageResampled = 0
  let last: { text: string; truncated: boolean } = { text: '', truncated: false }
  const onDelta = sc.onPartial ? (t: string): void => { sc.onPartial!(restoreFacts(t, sc.pd, false, locks)) } : undefined
  const complete = (): ReturnType<HumanizerBackend['complete']> => (onDelta
    ? sc.backend.complete(prompt, sc.nPredict, sc.signal, onDelta)
    : sc.backend.complete(prompt, sc.nPredict, sc.signal))
  for (let k = 1; k <= Math.max(1, sc.factTries); k++) {
    sc.counter.requests++
    let r = await complete()
    let text = pyStrip(r.text)
    // Language guard: same prompt, same settings, sample again (official: up to 3 times).
    let lang = 0
    while (lang < sc.langRetries && text && languageDrift(sc.draft, restoreFacts(text, sc.pd, false, locks), kept)) {
      lang++
      sc.counter.requests++
      r = await complete()
      text = pyStrip(r.text)
    }
    languageResampled += lang
    last = { text, truncated: r.truncated }
    if (locks.length === 0) break
    try {
      if (r.truncated) throw new FactsLostError()
      const restored = restoreFacts(text, sc.pd, true, locks)
      last = { text: restored, truncated: r.truncated }
      return finish(sc, last, languageResampled, k, t0)
    } catch (error) {
      if (!(error instanceof FactsLostError)) throw error
    }
  }
  if (locks.length > 0) {
    return {
      text: sc.draft,
      copyRate: 1,
      issues: ['keep_failed'],
      missingNumbers: [],
      addedNumbers: [],
      missingUrls: [],
      truncated: last.truncated,
      languageResampled,
      keepTries: sc.factTries,
      seconds: (Date.now() - t0) / 1000,
    }
  }
  return finish(sc, last, languageResampled, 1, t0)
}

function finish(sc: SampleContext, r: { text: string; truncated: boolean }, languageResampled: number, keepTries: number, t0: number): Candidate {
  const c = check(sc.draft, r.text, r.truncated, sc.maxCopy, sc.sizer, locksIn(sc.unit.text, sc.pd).map((l) => l.value))
  return {
    text: r.text,
    copyRate: c.copy,
    issues: c.issues,
    missingNumbers: c.missingNumbers,
    addedNumbers: c.addedNumbers,
    missingUrls: c.missingUrls,
    truncated: r.truncated,
    languageResampled,
    keepTries,
    seconds: (Date.now() - t0) / 1000,
  }
}

function retryable(c: Candidate): boolean {
  return c.issues.includes('keep_failed') || shouldRetry(asCheck(c))
}

/** A planned document: the protected text, the hz plan and the rewritable units. */
export interface DocumentPlan {
  input: string
  pd: ProtectedDraft
  plan: Plan
  units: Array<{ id: number; kind: Unit['kind']; line: number; draft: string }>
  keepActive: string[]
  keepIgnored: string[]
  kept: Record<string, number>
}

export interface PlanDocumentOptions {
  keep?: readonly string[] | undefined
  maxWords?: number | undefined
  maxCjk?: number | undefined
}

/** Keep-locks over the whole document, then the hz planner (same as the tool). */
export function planDocument(input: string, options: PlanDocumentOptions = {}): DocumentPlan {
  const keep = (options.keep ?? []).filter((k) => typeof k === 'string' && k.trim() !== '')
  const pd = protectFacts(input, keep)
  const p = plan(pd.text, { maxWords: options.maxWords ?? MAX_WORDS, maxCjk: options.maxCjk ?? MAX_CJK })
  return {
    input,
    pd,
    plan: p,
    units: p.units.map((u) => ({ id: u.id, kind: u.kind, line: u.line, draft: restoreFacts(u.text, pd, false, locksIn(u.text, pd)) })),
    keepActive: pd.facts,
    keepIgnored: keep.filter((k) => !pd.facts.includes(k)),
    kept: p.kept,
  }
}

/** Live progress of one piece (UI streaming). */
export interface UnitHooks {
  /** A new sample starts (index into the piece's candidates; extra retries continue the count). */
  onSampleStart?(index: number): void
  /** Text of the sample being written, so far. */
  onPartial?(index: number, text: string): void
  /** A sample finished and was checked. */
  onCandidate?(index: number, candidate: Candidate): void
}

export interface RewriteUnitOptions extends Omit<HumanizeOptions, 'keep' | 'maxWords' | 'maxCjk'> {
  maxWords?: number
  maxCjk?: number
  counter?: { requests: number }
  hooks?: UnitHooks
}

/** Rewrite one planned piece: n samples (+ retries), checks, best by hz score. */
export async function rewriteUnit(doc: DocumentPlan, unitId: number, backend: HumanizerBackend, options: RewriteUnitOptions): Promise<PieceReport> {
  const unit = doc.plan.units.find((u) => u.id === unitId)
  if (!unit) throw new Error(`no piece ${unitId}`)
  if (options.signal.aborted) throw options.signal.reason
  const nSamples = clampSamples(options.nSamples)
  const retries = Math.max(0, options.retries ?? 1)
  const pt0 = Date.now()
  const locks = locksIn(unit.text, doc.pd)
  const draft = restoreFacts(unit.text, doc.pd, false, locks)
  const counted = await backend.tokenize(pyStrip(unit.text), options.signal)
  const tokens = counted ?? estimateTokens(latinWords(unit.text), cjkChars(unit.text))
  const hooks = options.hooks
  const candidates: Candidate[] = []
  const sc: SampleContext = {
    backend, pd: doc.pd, unit, draft,
    nPredict: nPredictFor(tokens, options.maxPredict),
    langRetries: options.langRetries ?? LANG_RETRIES,
    factTries: options.factTries ?? FACT_TRIES,
    maxCopy: options.maxCopy ?? MAX_COPY,
    sizer: new Sizer(options.maxWords ?? MAX_WORDS, options.maxCjk ?? MAX_CJK),
    signal: options.signal,
    counter: options.counter ?? { requests: 0 },
  }
  const one = async (): Promise<void> => {
    const index = candidates.length
    hooks?.onSampleStart?.(index)
    sc.onPartial = hooks?.onPartial ? (t: string): void => { hooks.onPartial!(index, t) } : undefined
    const c = await sampleOnce(sc)
    candidates.push(c)
    hooks?.onCandidate?.(index, c)
  }
  for (let i = 0; i < nSamples; i++) await one()
  for (let extra = 0; extra < retries && candidates.every(retryable); extra++) await one()
  return { id: unit.id, kind: unit.kind, line: unit.line, draft, words: countWords(draft), candidates, chosen: bestIndex(candidates), seconds: (Date.now() - pt0) / 1000 }
}

/** Index of the best candidate by the hz score (keep failures last). */
export function bestIndex(candidates: readonly Candidate[]): number {
  let chosen = 0
  candidates.forEach((c, i) => { if (compareCandidates(c, candidates[chosen]!) < 0) chosen = i })
  return chosen
}

/**
 * Put the document back together. `pick` returns the text for a piece, or undefined to leave
 * that piece as its original draft (not rewritten yet).
 */
export function assembleDocument(doc: DocumentPlan, pick: (unitId: number) => string | undefined): string {
  const results = new Map<number, string>()
  for (const u of doc.plan.units) {
    results.set(u.id, pick(u.id) ?? u.text)
  }
  return restoreFacts(render(doc.plan, results), doc.pd, false)
}

/** Warnings for a finished set of pieces (the same text the tool reports). */
export function documentWarnings(doc: DocumentPlan, pieces: PieceReport[]): string[] {
  const warnings = describeWarnings(pieces)
  if (doc.plan.units.length === 0) warnings.push('没有可改写的正文（全是标题/代码/表格/过短段落等原样保留内容），原文未改动')
  if (doc.keepIgnored.length > 0) warnings.push(`这些 keep 片段在原文里找不到（需逐字匹配），已忽略：${doc.keepIgnored.map((k) => `「${k}」`).join('、')}`)
  return warnings
}

export async function humanize(input: string, backend: HumanizerBackend, options: HumanizeOptions): Promise<HumanizeResult> {
  const t0 = Date.now()
  const nSamples = clampSamples(options.nSamples)
  const doc = planDocument(input, options)
  const counter = { requests: 0 }
  const pieces: PieceReport[] = []
  for (const unit of doc.plan.units) {
    if (options.signal.aborted) throw options.signal.reason
    pieces.push(await rewriteUnit(doc, unit.id, backend, { ...options, nSamples, counter }))
  }
  const byId = new Map(pieces.map((p) => [p.id, p]))
  const text = assembleDocument(doc, (id) => { const p = byId.get(id)!; return p.candidates[p.chosen]!.text })
  const variants = nSamples > 1
    ? Array.from({ length: nSamples }, (_, k) => assembleDocument(doc, (id) => { const p = byId.get(id)!; return (p.candidates[k] ?? p.candidates[p.chosen]!).text }))
    : []
  return {
    text, variants, pieces, kept: doc.kept, warnings: documentWarnings(doc, pieces),
    keepActive: doc.keepActive, keepIgnored: doc.keepIgnored, nSamples,
    requests: counter.requests,
    seconds: (Date.now() - t0) / 1000,
  }
}
