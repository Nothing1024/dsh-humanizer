/**
 * TypeScript port of the official `humanizer/hz_text.py` (sgaofen/humanizer-local-model,
 * Apache-2.0, Copyright 2026 Stephen Yu — see NOTICE in this package). Cuts a long text or
 * Markdown document into pieces the model can rewrite, puts the rewrites back in place, and
 * checks every rewrite. Behaviour, regexes and thresholds follow hz_text.py line by line; the
 * comments carry the reasons from the original.
 *
 * How a document is cut (see {@link plan}):
 *  - Blank lines separate blocks. Fenced code, $$ math and HTML comments stay whole.
 *  - Kept exactly as written, never sent to the model: headings (ATX, setext, **bold**-only lines),
 *    fenced and indented code, tables, image/link-only lines, HTML blocks, $$ / \[ math, block
 *    quotes, horizontal rules, YAML front matter, footnote/link definitions, and everything under a
 *    References / Bibliography / 参考文献 heading.
 *  - Prose paragraphs are grouped in order into pieces of at most ~350 English words or 600
 *    Chinese characters. A piece never crosses a heading or a kept block.
 *  - A paragraph longer than that is cut at sentence ends and joined back into one paragraph.
 *  - List items keep their bullet/number (and a leading **Label:**); long items are rewritten
 *    on their own, short items are kept.
 * @module dsh-tool-humanize/text
 */

// ── sizes ───────────────────────────────────────────────────────────────────────────────────────
export const CJK_SRC = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af'
const CJK = new RegExp(`[${CJK_SRC}]`)
const CJK_G = new RegExp(`[${CJK_SRC}]`, 'g')
export const MAX_WORDS = 350 // English words per piece
export const MAX_CJK = 600 // Chinese characters per piece
export const MIN_PROSE = 6 // a prose piece smaller than this (English-word equivalents) is kept as is
export const MIN_ITEM = 15 // a list item smaller than this is kept as is

const ALNUM = /[\p{L}\p{N}]/u

/** Python `str.split()` (no argument): split on runs of whitespace, drop empties. */
export function pySplit(s: string): string[] {
  return s.split(/\s+/u).filter((t) => t !== '')
}

export function latinWords(text: string): number {
  return pySplit(text.replace(CJK_G, ' ')).filter((t) => ALNUM.test(t)).length
}

export function cjkChars(text: string): number {
  return (text.match(CJK_G) ?? []).length
}

// ── language guard ──────────────────────────────────────────────────────────────────────────────
// The model occasionally rewrites a short, informal English draft full of technical jargon in
// Chinese. Only counts characters: a draft with at most 2 Chinese characters whose rewrite has more
// than 15 is in the wrong language, and so is a Chinese draft whose rewrite is plain English.
// Same thresholds as the app (app/web/js/guard.js) and hz_text.language_drift.
const HAN_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const LETTER_WORD_G = /[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/g
export const LANG_RETRIES = 3

export function hanChars(text: string | undefined): number {
  return ((text ?? '').match(HAN_G) ?? []).length
}

function letterWords(text: string | undefined): number {
  return ((text ?? '').match(LETTER_WORD_G) ?? []).length
}

function without(text: string, literals: readonly string[]): string {
  let t = text
  for (const l of literals) if (l) t = t.split(l).join(' ')
  return t
}

/**
 * True if the rewrite is in the wrong language (English draft → Chinese, or Chinese draft → English).
 * `keep` = verbatim-kept literals: they are excluded from both counts, so a kept Chinese name in an
 * otherwise all-English rewrite of a Chinese draft still counts as drift (and vice versa).
 */
export function languageDrift(draft: string, out: string, keep: readonly string[] = []): boolean {
  if (keep.length) { draft = without(draft, keep); out = without(out, keep) }
  const hd = hanChars(draft)
  const ho = hanChars(out)
  if (hd <= 2) return ho > 15
  return hd >= 20 && hd > letterWords(draft) && ho <= 2 && letterWords(out) > 15
}

/** Words as reported to the user: English words plus Chinese characters. */
export function countWords(text: string): number {
  return latinWords(text) + cjkChars(text)
}

export function isCjk(text: string): boolean {
  return cjkChars(text) > latinWords(text)
}

/** Size of a text in English-word equivalents: a Chinese character counts max_words/max_cjk words. */
export class Sizer {
  readonly maxWords: number
  readonly ratio: number
  constructor(maxWords: number = MAX_WORDS, maxCjk: number = MAX_CJK) {
    this.maxWords = Math.max(20, Math.trunc(maxWords))
    this.ratio = this.maxWords / Math.max(20, Math.trunc(maxCjk))
  }

  size(text: string): number {
    return latinWords(text) + cjkChars(text) * this.ratio
  }
}

// ── sentence cutting ────────────────────────────────────────────────────────────────────────────
const SENT_END = () => /[.!?]+[)"'\u2019\u201d\]]*(?=\s)|[。！？]+[\u201d\u2019"」』)）]*/g
const CLAUSE_END = () => /[;:,]\s+|[；：，、]/g

function splitBy(text: string, pat: RegExp): string[] {
  const parts: string[] = []
  let last = 0
  for (const m of text.matchAll(pat)) {
    const end = m.index + m[0].length
    const s = text.slice(last, end).trim()
    if (s) parts.push(s)
    last = end
  }
  const tail = text.slice(last).trim()
  if (tail) parts.push(tail)
  return parts
}

// ── number checks ───────────────────────────────────────────────────────────────────────────────
const NUM_G = () => /\d+(?:[.,]\d+)*/g
const NUM_TEST = /\d+(?:[.,]\d+)*/
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/
// a scale right after a number: 480k, 1.2M, 3MM, 12B, 2 million, 31.7万, 1.5亿
const SCALE = /(?:(k|K|MM|M|B)(?![A-Za-z])|\s?(bn|mn)\b|\s(thousand|million|billion|trillion)\b|(千万|百万|万|亿))/y
const SCALES: Record<string, number> = {
  k: 3, K: 3, thousand: 3, M: 6, MM: 6, mn: 6, million: 6, B: 9, bn: 9, billion: 9,
  trillion: 12, '万': 4, '百万': 6, '千万': 7, '亿': 8,
}
const EN_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 10 ** 6, billion: 10 ** 9, dozen: 12, once: 1, twice: 2, double: 2, triple: 3,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, single: 1, pair: 2, couple: 2,
}
const CN_DIGIT: Record<string, number> = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
const CN_UNIT: Record<string, number> = { '十': 10, '百': 100, '千': 1000 }
const CN_RUN_G = () => /[零〇一二两三四五六七八九十百千万亿]+/g

function normInt(s: string): string {
  return s.replace(/^0+/, '') || '0'
}

function normDec(s: string): string {
  const i = s.indexOf('.')
  const whole = i < 0 ? s : s.slice(0, i)
  const frac = i < 0 ? '' : s.slice(i + 1).replace(/0+$/, '')
  return normInt(whole) + (frac ? '.' + frac : '')
}

/** Decimal(key).scaleb(exp), formatted like hz_text._scaled (exact, string arithmetic). */
export function scaled(key: string, exp: number): string {
  const i = key.indexOf('.')
  const whole = i < 0 ? key : key.slice(0, i)
  const frac = i < 0 ? '' : key.slice(i + 1)
  const digits = whole + frac
  let point = whole.length + exp
  let ds = digits
  if (point > ds.length) ds = ds + '0'.repeat(point - ds.length)
  if (point < 0) { ds = '0'.repeat(-point) + ds; point = 0 }
  const w = ds.slice(0, point)
  const f = ds.slice(point)
  const s = f ? `${w || '0'}.${f}` : (w || '0')
  return s.includes('.') ? normDec(s) : normInt(s)
}

type Occurrence = { raw: string; key: string; scaled: string | undefined }

/** Every number written with digits: (raw spelling, plain key, scaled key). */
function occurrences(text: string | undefined): Occurrence[] {
  const t = (text ?? '').normalize('NFKC')
  const found: Occurrence[] = []
  for (const m of t.matchAll(NUM_G())) {
    const raw = m[0]
    let keys: string[]
    if (THOUSANDS.test(raw)) {
      keys = [normDec(raw.replaceAll(',', ''))]
    } else {
      keys = []
      for (const part of raw.split(',')) {
        if ((part.match(/\./g) ?? []).length === 1) keys.push(normDec(part))
        else keys.push(...part.split('.').filter((p) => p).map(normInt))
      }
    }
    SCALE.lastIndex = m.index + raw.length
    const sm = SCALE.exec(t)
    const unit = sm ? sm.slice(1).find((g) => g) : undefined
    const exp = unit !== undefined ? SCALES[unit] ?? 0 : 0
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1
      found.push({
        raw: raw + (sm && last ? sm[0] : ''),
        key: k,
        scaled: exp && last ? scaled(k, exp) : undefined,
      })
    })
  }
  return found
}

function cnValue(s: string): number {
  let total = 0
  let section = 0
  let num = 0
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      num = CN_DIGIT[ch]!
    } else if (ch in CN_UNIT) {
      section += (num || 1) * CN_UNIT[ch]!
      num = 0
    } else if (ch === '万') {
      total += (section + num) * 10 ** 4
      section = 0
      num = 0
    } else if (ch === '亿') {
      total = (total + section + num) * 10 ** 8
      section = 0
      num = 0
    }
  }
  return total + section + num
}

/** Numbers written as words: English (eight, twenty-five, twice, third) and Chinese numerals. */
function wordKeys(text: string | undefined): Set<string> {
  const keys = new Set<string>()
  for (const w of (text ?? '').toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? []) {
    const parts = w.split('-')
    const vals = parts.map((x) => EN_NUM[x])
    if (parts.length === 2 && vals[0] !== undefined && vals[1] !== undefined && vals[0] >= 20 && vals[1] < 10) {
      keys.add(String(vals[0] + vals[1]))
    }
    for (const v of vals) if (v !== undefined) keys.add(String(v))
  }
  for (const run of (text ?? '').match(CN_RUN_G()) ?? []) {
    keys.add(String(cnValue(run)))
    for (const c of run) if (c in CN_DIGIT) keys.add(String(CN_DIGIT[c]))
  }
  return keys
}

/** {normalized number: first spelling seen}, for numbers written with digits. */
export function numbers(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const o of occurrences(text)) {
    const k = o.scaled ?? o.key
    if (!out.has(k)) out.set(k, o.raw)
  }
  return out
}

function allKeys(text: string): Set<string> {
  const keys = wordKeys(text)
  for (const o of occurrences(text)) {
    keys.add(o.key)
    if (o.scaled) keys.add(o.scaled)
  }
  return keys
}

/** Numbers in the draft that the rewrite does not contain (in any spelling), as spelled in the draft. */
export function missingNumbers(draft: string, out: string): string[] {
  const have = allKeys(out)
  return [...numbers(draft)].filter(([k]) => !have.has(k)).map(([, raw]) => raw)
}

/** Numbers in the rewrite that the draft does not contain in any spelling: possibly made up. */
export function addedNumbers(draft: string, out: string): string[] {
  const have = allKeys(draft)
  return [...numbers(out)].filter(([k]) => !have.has(k)).map(([, raw]) => raw)
}

const URL_G = () => /https?:\/\/[^\s<>()[\]"'`]+/g

export function urls(text: string | undefined): string[] {
  const seen: string[] = []
  for (let u of (text ?? '').match(URL_G()) ?? []) {
    u = u.replace(/[.,;:!?]+$/, '')
    if (!seen.includes(u)) seen.push(u)
  }
  return seen
}

export function missingUrls(draft: string, out: string): string[] {
  return urls(draft).filter((u) => !(out ?? '').includes(u))
}

// ── copy rate ───────────────────────────────────────────────────────────────────────────────────
function grams(text: string | undefined, cjk: boolean, n = 5, k = 6): string[] {
  const w = (text ?? '').toLowerCase().replaceAll('\u2019', "'").match(/[a-z0-9']+/g) ?? []
  const g: string[] = []
  for (let i = 0; i + n <= w.length; i++) g.push('w:' + w.slice(i, i + n).join(' '))
  if (cjk) {
    const s = Array.from((text ?? '').replace(/\s+/g, ''))
    for (let i = 0; i + k <= s.length; i++) {
      const piece = s.slice(i, i + k).join('')
      if (CJK.test(piece)) g.push('c:' + piece)
    }
  }
  return g
}

/** Share of the rewrite's word 5-grams (Chinese: 6-character grams) that also appear in the draft. */
export function copyRate(draft: string, out: string): number {
  const cjk = CJK.test(draft ?? '') || CJK.test(out ?? '')
  const g = grams(out, cjk)
  if (g.length === 0) return 0
  const dg = new Set(grams(draft, cjk))
  return g.filter((x) => dg.has(x)).length / g.length
}

function sentUnits(sent: string): Set<string> {
  if (CJK.test(sent)) {
    const s = Array.from(sent.replace(/[^\p{L}\p{N}_]/gu, ''))
    const out = new Set<string>()
    for (let i = 0; i + 1 < s.length; i++) out.add(s[i]! + s[i + 1]!)
    return out
  }
  return new Set((sent.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 3))
}

/** Two sentences that say nearly the same thing (≥ 50 % of the shorter one's units in the other). */
export function hasRepeat(text: string | undefined, thr = 0.5, minUnits = 5): boolean {
  const sents = splitBy((text ?? '').replace(/\s+/g, ' '), SENT_END()).map(sentUnits).filter((u) => u.size >= minUnits)
  for (let i = 0; i < sents.length; i++) {
    for (let j = i + 1; j < sents.length; j++) {
      const a = sents[i]!
      const b = sents[j]!
      let inter = 0
      for (const x of a) if (b.has(x)) inter++
      if (inter / Math.min(a.size, b.size) >= thr) return true
    }
  }
  return false
}

const TAG_G = () => /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>\n]*)?\/?>/g

/** HTML tags in the rewrite that the draft does not have. */
export function strayMarkup(draft: string, out: string): string[] {
  return [...new Set((out ?? '').match(TAG_G()) ?? [])].filter((t) => !(draft ?? '').includes(t)).sort()
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────
/** Problems that make hz rewrite a piece again. 'added_numbers' is only reported, never retried. */
export const RETRY_ISSUES = ['empty', 'truncated', 'too_short', 'too_long', 'repeated', 'markup', 'missing_numbers', 'missing_urls', 'copy'] as const
export const TOO_SHORT = 0.35
export const TOO_LONG = 1.75
export const TOO_LONG_MIN = 12
export const MAX_COPY = 0.5

export type Issue = 'empty' | 'truncated' | 'too_short' | 'too_long' | 'repeated' | 'language' | 'markup' | 'missing_numbers' | 'missing_urls' | 'copy' | 'added_numbers'

export interface Check {
  copy: number
  missingNumbers: string[]
  missingUrls: string[]
  addedNumbers: string[]
  issues: Issue[]
}

export function shouldRetry(c: Check): boolean {
  return c.issues.some((i) => (RETRY_ISSUES as readonly string[]).includes(i))
}

const ISSUE_WEIGHT: Partial<Record<Issue, number>> = { empty: 1000, language: 200, truncated: 100, too_short: 50, too_long: 50, repeated: 50 }

/** Lower is better: [problem count, copy rate] compared lexicographically. */
export function score(c: Check): [number, number] {
  let bad = c.missingNumbers.length + c.missingUrls.length + c.addedNumbers.length + (c.issues.includes('copy') ? 1 : 0)
  bad += c.issues.includes('markup') ? 1 : 0
  for (const i of c.issues) bad += ISSUE_WEIGHT[i] ?? 0
  return [bad, c.copy]
}

export function compareScore(a: Check, b: Check): number {
  const [x0, x1] = score(a)
  const [y0, y1] = score(b)
  return x0 - y0 || x1 - y1
}

export function check(draft: string, out: string, truncated = false, maxCopy = MAX_COPY, sizer: Sizer = new Sizer(), keep: readonly string[] = []): Check {
  const c = copyRate(draft, out)
  const mn = missingNumbers(draft, out)
  const mu = missingUrls(draft, out)
  const an = addedNumbers(draft, out)
  const empty = !(out ?? '').trim()
  const din = sizer.size(draft)
  const dout = sizer.size(out)
  const issues: Issue[] = []
  if (empty) issues.push('empty')
  if (truncated) issues.push('truncated')
  if (!empty && din >= 30 && dout < TOO_SHORT * din) issues.push('too_short')
  if (dout > TOO_LONG * din && dout - din >= TOO_LONG_MIN) issues.push('too_long')
  if (!empty && hasRepeat(out) && !hasRepeat(draft)) issues.push('repeated')
  if (!empty && languageDrift(draft, out, keep)) issues.push('language')
  if (strayMarkup(draft, out).length > 0) issues.push('markup')
  if (mn.length > 0) issues.push('missing_numbers')
  if (mu.length > 0) issues.push('missing_urls')
  if (c > maxCopy) issues.push('copy')
  if (an.length > 0) issues.push('added_numbers')
  return { copy: Math.round(c * 1000) / 1000, missingNumbers: mn, missingUrls: mu, addedNumbers: an, issues }
}

// ── long paragraphs ─────────────────────────────────────────────────────────────────────────────
function joiner(text: string): string {
  return isCjk(text) ? '' : ' '
}

/** Group consecutive parts into pieces of at most `limit`, about equally large. */
function balanced(parts: string[], sizer: Sizer, limit: number, j: string): string[] {
  const sizes = parts.map((p) => sizer.size(p))
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= limit) return [parts.join(j)]
  const target = total / Math.ceil(total / limit)
  const groups: string[] = []
  let cur: string[] = []
  let cw = 0
  parts.forEach((p, i) => {
    const w = sizes[i]!
    if (cur.length > 0 && (cw + w > limit || cw + w / 2 > target)) {
      groups.push(cur.join(j))
      cur = []
      cw = 0
    }
    cur.push(p)
    cw += w
  })
  if (cur.length > 0) groups.push(cur.join(j))
  return groups
}

/** Cut one over-long paragraph at sentence ends (then clause marks, then words) into pieces. */
export function cutLong(text: string, sizer: Sizer, limit?: number): string[] {
  const lim = limit ?? sizer.maxWords
  const j = joiner(text)
  const flat = text.trim().replace(/\s*\n\s*/g, j || ' ')
  const pieces: string[] = []
  for (const sent of splitBy(flat, SENT_END())) {
    if (sizer.size(sent) <= lim * 1.5) {
      pieces.push(sent)
      continue
    }
    for (const clause of splitBy(sent, CLAUSE_END())) {
      if (sizer.size(clause) <= lim * 1.5) {
        pieces.push(clause)
      } else if (j === ' ') {
        const ws = pySplit(clause)
        const step = Math.max(1, Math.trunc(lim))
        for (let i = 0; i < ws.length; i += step) pieces.push(ws.slice(i, i + step).join(' '))
      } else {
        const cs = Array.from(clause)
        const step = Math.max(1, Math.trunc(lim / sizer.ratio))
        for (let i = 0; i < cs.length; i += step) pieces.push(cs.slice(i, i + step).join(''))
      }
    }
  }
  return balanced(pieces, sizer, lim, j)
}

// ── block scanner ───────────────────────────────────────────────────────────────────────────────
const FENCE = /^ {0,3}(`{3,}|~{3,}|:{3,})/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST = /^([ \t]*)([-*+•]|\d{1,3}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/
const QUOTE = /^ {0,3}>/
const HTML_START = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*[\s/>]|[A-Za-z][A-Za-z0-9-]*$|\/[A-Za-z]|!--|!\[CDATA\[|![A-Z]|\?)/
const MATH_OPEN = /^ {0,3}(\$\$|\\\[)/
const REFDEF = /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:[ \t]*\S/
const CITE_ENTRY = /^ {0,3}(?:\[\d{1,4}\]|\[\^[^\]]+\])\s/
const BOLD_LINE = /^\s*(\*\*|__)(?=\S)([^*_\n]+?)(?<=\S)\1\s*[:：]?\s*$/
const LEADIN = /^((?:\*\*|__)[^*_\n]{1,80}?(?:\*\*|__)\s*[:：.。—–-]?\s*)(.*)$/s
const PLAIN_LEADIN = /^([^\s:：.!?。！？][^:：.!?。！？\n]{0,40}[:：]\s*)(.+)$/s
const LINKY_SRC = String.raw`\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)|!?\[[^\]]*\]\[[^\]]*\]|\[[^\]]*\]\([^)]*\)|<img\b[^>]*>|<a\b[^>]*>.*?</a>|<https?://[^>]+>|https?://\S+`
const REF_TITLE = /^(?:\d+(?:\.\d+)*\.?\s+|[IVXLC]+\.\s+)?(references?|bibliography|works cited|literature cited|cited works|reference list|sources|citations|参考文献|参考资料|引用文献|文献|引用)\s*[:：]?$/i

const REWRITABLE = ['prose', 'list']

export type BlockKind = 'prose' | 'list' | 'heading' | 'code' | 'table' | 'media' | 'html' | 'math' | 'quote' | 'hr' | 'frontmatter' | 'refdef' | 'references' | 'intro'

export interface Block {
  kind: BlockKind
  start: number
  end: number
  level: number
  indent: string
}

function block(kind: BlockKind, start: number, end: number, level = 0): Block {
  return { kind, start, end, level, indent: '' }
}

function stripChars(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a]!)) a++
  while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

function isFenceClose(line: string, fence: string): boolean {
  const s = line.trim()
  return s.length >= fence.length && s.length > 0 && [...s].every((c) => c === fence[0])
}

function isLinkOnly(line: string): boolean {
  if (!new RegExp(LINKY_SRC).test(line)) return false
  return stripChars(line.replace(new RegExp(LINKY_SRC, 'g'), ''), ' \t|·•,;-–—') === ''
}

function headingTitle(lines: string[], b: Block): string {
  let s = lines[b.start]!
  s = s.replace(/^ {0,3}#{1,6}[ \t]*/, '')
  s = s.replace(/[ \t]+#+[ \t]*$/, '')
  return stripChars(s.trim(), '*_').trim()
}

function lstripWs(l: string): string {
  return l.replace(/^[ \t]+/, '')
}

/** Line scanner → blocks in document order. Blank lines belong to no block. */
export function scan(lines: string[]): Block[] {
  const blocks: Block[] = []
  const n = lines.length
  let i = 0
  if (n > 0 && lines[0]!.trim() === '---') { // YAML front matter
    for (let j = 1; j < n; j++) {
      const t = lines[j]!.trim()
      if (t === '---' || t === '...') {
        blocks.push(block('frontmatter', 0, j + 1))
        i = j + 1
        break
      }
    }
  }
  let cur: Block | undefined
  const close = (): void => {
    if (cur !== undefined) {
      blocks.push(cur)
      cur = undefined
    }
  }
  const extend = (kind: BlockKind): void => {
    if (cur !== undefined && cur.kind === kind) cur.end = i + 1
    else {
      close()
      cur = block(kind, i, i + 1)
    }
  }
  while (i < n) {
    const line = lines[i]!
    const c = cur
    if (!line.trim()) {
      close()
      i++
      continue
    }
    if (c !== undefined && c.kind === 'html') { // an HTML block runs to the next blank line
      c.end = i + 1
      i++
      continue
    }
    let m = FENCE.exec(line)
    if (m) {
      close()
      const fence = m[1]!
      let j = i + 1
      while (j < n && !isFenceClose(lines[j]!, fence)) j++
      const end = Math.min(j + 1, n)
      blocks.push(block('code', i, end))
      i = end
      continue
    }
    m = MATH_OPEN.exec(line)
    if (m) {
      close()
      const s = line.trim()
      const closer = m[1] === '$$' ? '$$' : '\\]'
      let end: number
      if (s.length > closer.length + 1 && s.endsWith(closer)) end = i + 1
      else {
        let j = i + 1
        while (j < n && !lines[j]!.trimEnd().endsWith(closer)) j++
        end = Math.min(j + 1, n)
      }
      blocks.push(block('math', i, end))
      i = end
      continue
    }
    if (lstripWs(line).startsWith('<!--')) {
      close()
      let j = i
      while (j < n && !lines[j]!.includes('-->')) j++
      const end = Math.min(j + 1, n)
      blocks.push(block('html', i, end))
      i = end
      continue
    }
    m = ATX.exec(line)
    if (m) {
      close()
      blocks.push(block('heading', i, i + 1, m[1]!.length))
      i++
      continue
    }
    if (c !== undefined && c.kind === 'prose' && SETEXT.test(line)) {
      c.kind = 'heading'
      c.end = i + 1
      c.level = line.includes('=') ? 1 : 2
      close()
      i++
      continue
    }
    if (HR.test(line)) {
      close()
      blocks.push(block('hr', i, i + 1))
      i++
      continue
    }
    if ((c !== undefined && c.kind === 'table' && line.includes('|')) || lstripWs(line).startsWith('|') || (
      line.includes('|') && i + 1 < n && lines[i + 1]!.includes('|') && TABLE_DELIM.test(lines[i + 1]!))) {
      extend('table')
      i++
      continue
    }
    if (QUOTE.test(line)) {
      extend('quote')
      i++
      continue
    }
    if (HTML_START.test(line)) {
      close()
      cur = block('html', i, i + 1)
      i++
      continue
    }
    if (LIST.test(line)) {
      extend('list')
      i++
      continue
    }
    if (REFDEF.test(line)) {
      close()
      cur = block('refdef', i, i + 1)
      i++
      continue
    }
    if (c !== undefined && ['prose', 'list', 'html', 'quote', 'refdef'].includes(c.kind)) {
      c.end = i + 1 // paragraph or lazy continuation line
    } else {
      close()
      cur = block('prose', i, i + 1)
    }
    i++
  }
  close()

  // second pass: what kind of prose is it, and is it inside a References section
  let prev: Block | undefined
  for (const b of blocks) {
    if (b.kind === 'prose') {
      const ls = lines.slice(b.start, b.end)
      const ind = Math.min(...ls.map((l) => l.length - lstripWs(l).length))
      if (ls.every(isLinkOnly)) {
        b.kind = 'media'
      } else if (ls.length === 1 && BOLD_LINE.test(ls[0]!) && latinWords(ls[0]!) + Math.floor(cjkChars(ls[0]!) / 2) <= 14) {
        b.kind = 'heading'
        b.level = 7
      } else if (ls.length === 1 && REF_TITLE.test(stripChars(ls[0]!.trim(), '*_').trim())) {
        b.kind = 'heading'
        b.level = 7
      } else if (ls.slice(0, 1).every((l) => CITE_ENTRY.test(l)) && ls.length <= 6) {
        b.kind = 'references'
      } else if (ind >= 4 && !(prev !== undefined && (prev.kind === 'list' || (prev.kind === 'prose' && prev.indent)))) {
        b.kind = 'code' // indented code block (not a list item's paragraph)
      } else if (ind > 0) {
        const head = ls[0]!.slice(0, ind)
        b.indent = head.trim() === '' ? head : ' '.repeat(ind)
      }
    }
    prev = b
  }
  for (let k = 0; k + 1 < blocks.length; k++) { // "Key points:" right before a list, table or code
    const b = blocks[k]!
    const nxt = blocks[k + 1]!
    if (b.kind === 'prose' && ['list', 'table', 'code', 'math', 'quote'].includes(nxt.kind) && b.end - b.start === 1) {
      const s = lines[b.start]!.trim()
      if ((s.endsWith(':') || s.endsWith('：')) && latinWords(s) + Math.floor(cjkChars(s) / 2) <= 15) b.kind = 'intro'
    }
  }
  let refLevel: number | undefined
  for (const b of blocks) {
    if (b.kind === 'heading') {
      if (refLevel !== undefined && b.level <= refLevel) refLevel = undefined
      if (REF_TITLE.test(headingTitle(lines, b))) refLevel = b.level
      continue
    }
    if (refLevel !== undefined && REWRITABLE.includes(b.kind)) b.kind = 'references'
  }
  return blocks
}

// ── plan ────────────────────────────────────────────────────────────────────────────────────────
export interface Unit {
  id: number
  /** The draft sent to the model. */
  text: string
  kind: 'prose' | 'item' | 'sentences'
  /** 1-based line number in the input. */
  line: number
}

type Render = (results: Map<number, string>) => string

export interface Plan {
  lines: string[]
  blocks: Block[]
  units: Unit[]
  repl: Array<[number, number, Render]>
  kept: Record<string, number>
  crlf: boolean
}

/** Put the rewrites back in place; kept lines are copied verbatim. */
export function render(p: Plan, results: Map<number, string>): string {
  const out: string[] = []
  let i = 0
  for (const [s, e, fn] of [...p.repl].sort((a, b) => a[0] - b[0])) {
    out.push(...p.lines.slice(i, s))
    out.push(fn(results))
    i = e
  }
  out.push(...p.lines.slice(i))
  const text = out.join('\n')
  return p.crlf ? text.replaceAll('\n', '\r\n') : text
}

function oneline(text: string | undefined): string {
  return pySplit(text ?? '').join(' ')
}

function reindent(text: string, indent: string): string {
  if (!indent) return text
  return text.split('\n').map((l) => (l.trim() ? indent + l : l)).join('\n')
}

/** '**Label:** rest' or 'Label: rest' → [lead-in kept verbatim, rest to rewrite]. */
export function splitLeadin(text: string): [string, string] {
  let m = LEADIN.exec(text)
  if (m && m[2]!.trim()) return [m[1]!, m[2]!]
  m = PLAIN_LEADIN.exec(text)
  if (m && latinWords(m[1]!) <= 5 && cjkChars(m[1]!) <= 10 && !NUM_TEST.test(m[1]!)) return [m[1]!, m[2]!]
  return ['', text]
}

function kept(p: Plan, kind: string, n = 1): void {
  p.kept[kind] = (p.kept[kind] ?? 0) + n
}

export interface PlanOptions {
  maxWords?: number
  maxCjk?: number
  minProse?: number
  minItem?: number
}

export class Planner {
  readonly sizer: Sizer
  readonly minProse: number
  readonly minItem: number

  constructor(options: PlanOptions = {}) {
    this.sizer = new Sizer(options.maxWords ?? MAX_WORDS, options.maxCjk ?? MAX_CJK)
    this.minProse = options.minProse ?? MIN_PROSE
    this.minItem = options.minItem ?? MIN_ITEM
  }

  planText(input: string): Plan {
    const crlf = input.includes('\r\n')
    const text = input.replaceAll('\r\n', '\n')
    const lines = text.split('\n')
    const p: Plan = { lines, blocks: scan(lines), units: [], repl: [], kept: {}, crlf }
    let run: Block[] = []
    for (const b of p.blocks) {
      if (b.kind === 'prose') {
        if (run.length > 0 && b.indent !== run[run.length - 1]!.indent) {
          this.proseRun(p, run)
          run = []
        }
        run.push(b)
        continue
      }
      if (run.length > 0) {
        this.proseRun(p, run)
        run = []
      }
      if (b.kind === 'list') this.list(p, b)
      else kept(p, b.kind)
    }
    if (run.length > 0) this.proseRun(p, run)
    return p
  }

  private add(p: Plan, text: string, kind: Unit['kind'], line: number): number {
    const id = p.units.length + 1
    p.units.push({ id, text, kind, line })
    return id
  }

  private blockText(p: Plan, b: Block): string {
    const k = b.indent.length
    return p.lines.slice(b.start, b.end).map((l) => (l.slice(0, k).trim() === '' ? l.slice(k) : lstripWs(l))).join('\n').trim()
  }

  /** Consecutive prose paragraphs (only blank lines between them) → pieces of at most maxWords. */
  private proseRun(p: Plan, run: Block[]): void {
    const limit = this.sizer.maxWords
    const sizes = run.map((b) => this.sizer.size(this.blockText(p, b)))
    let i = 0
    while (i < run.length) {
      if (sizes[i]! > limit) { // one over-long paragraph: cut at sentences
        this.longPara(p, run[i]!)
        i++
        continue
      }
      let j = i
      while (j < run.length && sizes[j]! <= limit) j++
      const sub = run.slice(i, j)
      const ss = sizes.slice(i, j)
      const total = ss.reduce((a, b) => a + b, 0)
      const target = total / Math.max(1, Math.ceil(total / limit))
      let group: Block[] = []
      let gw = 0
      sub.forEach((b, idx) => {
        const w = ss[idx]!
        if (group.length > 0 && (gw + w > limit || gw + w / 2 > target)) {
          this.proseGroup(p, group)
          group = []
          gw = 0
        }
        group.push(b)
        gw += w
      })
      if (group.length > 0) this.proseGroup(p, group)
      i = j
    }
  }

  private proseGroup(p: Plan, group: Block[]): void {
    const first = group[0]!
    const last = group[group.length - 1]!
    const ind = first.indent
    const k = ind.length
    const text = p.lines.slice(first.start, last.end).map((l) => (l.slice(0, k).trim() === '' ? l.slice(k) : lstripWs(l))).join('\n').trim()
    if (this.sizer.size(text) < this.minProse) {
      kept(p, 'short', group.length)
      return
    }
    const uid = this.add(p, text, 'prose', first.start + 1)
    p.repl.push([first.start, last.end, (r) => reindent((r.get(uid) ?? text).trim(), ind)])
  }

  private longPara(p: Plan, b: Block): void {
    const text = this.blockText(p, b)
    const pieces = cutLong(text, this.sizer)
    const j = joiner(text)
    const uids = pieces.map((s) => this.add(p, s, 'sentences', b.start + 1))
    p.repl.push([b.start, b.end, (r) => reindent(uids.map((u, idx) => (r.get(u) ?? pieces[idx]!).trim()).join(j), b.indent)])
  }

  private list(p: Plan, b: Block): void {
    const items: Array<{ start: number; end: number; prefix: string; text: string }> = []
    for (let i = b.start; i < b.end; i++) {
      const line = p.lines[i]!
      const m = LIST.exec(line)
      if (m) {
        items.push({ start: i, end: i + 1, prefix: m[1]! + m[2]! + m[3]! + (m[4] ?? ''), text: m[5]! })
      } else if (items.length > 0) {
        const it = items[items.length - 1]!
        it.end = i + 1
        const sep = isCjk(it.text) && isCjk(line) ? '' : ' '
        it.text = it.text.trimEnd() + sep + line.trim()
      }
    }
    for (const it of items) {
      const [lead, rest] = splitLeadin(it.text.trim())
      if (this.sizer.size(rest) < this.minItem) {
        kept(p, 'list item')
        continue
      }
      const body = rest.trim()
      const uid = this.add(p, body, 'item', it.start + 1)
      const pre = it.prefix + lead
      p.repl.push([it.start, it.end, (r) => pre + oneline(r.get(uid) ?? body)])
    }
  }
}

export function plan(text: string, options: PlanOptions = {}): Plan {
  return new Planner(options).planText(text)
}
