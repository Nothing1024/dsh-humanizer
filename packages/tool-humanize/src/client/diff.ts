/**
 * Word-level diff for display — port of the official app's app/web/js/diff.js
 * (sgaofen/humanizer-local-model, Apache-2.0): English by word, Chinese by character, punctuation
 * alone; LCS over non-space tokens after trimming the common prefix/suffix, a conservative
 * semantic cleanup, and 1–2 changed punctuation marks left unmarked. Only colours the view; it
 * plays no part in the rewrite or its checks (those run on the host).
 */
const TOKEN_RE = /\p{Nd}+(?:[.,:/]\p{Nd}+)+|[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[\p{L}\p{N}\p{M}_]+(?:['\u2019][\p{L}\p{N}]+)*|\s+|[^\s]/gu
const CJK_ONE = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]$/
const PUNCT = /^[\p{P}\p{S}]+$/u
const MAX_CELLS = 25e6

export interface Token { t: string; ws: boolean; ci: number; n?: string; w?: number }

function norm(t: string): string {
  return t.normalize('NFKC').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
}

export function tokenize(s: string): Token[] {
  const out: Token[] = []
  let ci = 0
  for (const m of s.matchAll(TOKEN_RE)) {
    const t = m[0]
    if (/^\s+$/.test(t)) out.push({ t, ws: true, ci: -1 })
    else out.push({ t, ws: false, ci: ci++, n: norm(t), w: CJK_ONE.test(t) ? 2 : [...t].length })
  }
  return out
}

type Op = [number, number, number]

export interface DiffResult { a: Uint8Array; b: Uint8Array; ratio: number }

export function diffTokens(aTok: Token[], bTok: Token[]): DiffResult | null {
  const A = aTok.filter((x) => !x.ws)
  const B = bTok.filter((x) => !x.ws)
  const ids = new Map<string, number>()
  const id = (s: string): number => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v) } return v }
  const a = Int32Array.from(A, (x) => id(x.n!))
  const b = Int32Array.from(B, (x) => id(x.n!))
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  if ((n + 1) * (m + 1) > MAX_CELLS) return null
  const W = m + 1
  const dp = n < 65535 && m < 65535 ? new Uint16Array((n + 1) * W) : new Uint32Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[pre + i]
    const row = i * W
    const next = row + W
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = ai === b[pre + j] ? dp[next + j + 1]! + 1 : Math.max(dp[next + j]!, dp[row + j + 1]!)
    }
  }
  const ops: Op[] = []
  for (let k = 0; k < pre; k++) ops.push([0, k, k])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[pre + i] === b[pre + j]) { ops.push([0, pre + i, pre + j]); i++; j++ }
    else if (dp[(i + 1) * W + j]! >= dp[i * W + j + 1]!) { ops.push([-1, pre + i, -1]); i++ }
    else { ops.push([1, -1, pre + j]); j++ }
  }
  for (; i < n; i++) ops.push([-1, pre + i, -1])
  for (; j < m; j++) ops.push([1, -1, pre + j])
  for (let k = 0; k < suf; k++) ops.push([0, a.length - suf + k, b.length - suf + k])
  const clean = cleanup(ops, A, B)
  const am = new Uint8Array(A.length)
  const bm = new Uint8Array(B.length)
  for (const [op, x, y] of clean) {
    if (op === -1) am[x] = 1
    else if (op === 1) bm[y] = 1
  }
  quietPunct(am, A)
  quietPunct(bm, B)
  let insW = 0
  let allW = 0
  B.forEach((t, k) => { allW += t.w!; if (bm[k]) insW += t.w! })
  return { a: am, b: bm, ratio: allW ? insW / allW : 0 }
}

function quietPunct(marks: Uint8Array, toks: Token[]): void {
  for (let i = 0; i < marks.length;) {
    if (!marks[i]) { i++; continue }
    let j = i
    while (j < marks.length && marks[j]) j++
    if (j - i <= 2 && toks.slice(i, j).every((t) => PUNCT.test(t.t))) marks.fill(0, i, j)
    i = j
  }
}

interface Group { kind: number; ops: Op[]; len: number; del: number; ins: number }

function cleanup(ops: Op[], A: Token[], B: Token[]): Op[] {
  for (let pass = 0; pass < 6; pass++) {
    const groups: Group[] = []
    for (const op of ops) {
      const kind = op[0] === 0 ? 0 : 1
      let g = groups[groups.length - 1]
      if (!g || g.kind !== kind) { g = { kind, ops: [], len: 0, del: 0, ins: 0 }; groups.push(g) }
      g.ops.push(op)
      if (op[0] === 0) g.len += A[op[1]]!.w!
      else if (op[0] === -1) g.del += A[op[1]]!.w!
      else g.ins += B[op[2]]!.w!
    }
    let changed = false
    for (let k = 1; k < groups.length - 1; k++) {
      const g = groups[k]!
      if (g.kind !== 0) continue
      const p = groups[k - 1]!
      const q = groups[k + 1]!
      if (g.len * 2 <= Math.max(p.del, p.ins) && g.len * 2 <= Math.max(q.del, q.ins)) {
        g.kind = 1
        g.ops = g.ops.flatMap(([, x, y]): Op[] => [[-1, x, -1], [1, -1, y]])
        changed = true
      }
    }
    if (!changed) return ops
    ops = groups.flatMap((g) => g.ops)
  }
  return ops
}

/** Diff marks onto per-character bits (spaces between two marked words are marked too). */
export function markBits(tokens: Token[], marks: Uint8Array, bits: Uint8Array, bit: number): Uint8Array {
  let pos = 0
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]!
    let on: boolean
    if (!tk.ws) on = !!marks[tk.ci]
    else if (tk.t.includes('\n')) on = false
    else {
      let p = k - 1
      let q = k + 1
      while (p >= 0 && tokens[p]!.ws) p--
      while (q < tokens.length && tokens[q]!.ws) q++
      on = p >= 0 && q < tokens.length && !!marks[tokens[p]!.ci] && !!marks[tokens[q]!.ci]
    }
    if (on) for (let i = pos; i < pos + tk.t.length; i++) bits[i]! |= bit
    pos += tk.t.length
  }
  return bits
}

/** Every occurrence of each literal in `text` gets `bit`. */
export function literalBits(text: string, literals: readonly string[], bits: Uint8Array, bit: number): Uint8Array {
  for (const f of literals) {
    if (!f) continue
    for (let s = text.indexOf(f); s >= 0; s = text.indexOf(f, s + 1)) {
      for (let i = s; i < s + f.length; i++) bits[i]! |= bit
    }
  }
  return bits
}

/** Runs of equal bits: [text, bits][] for rendering. */
export function runs(text: string, bits: Uint8Array): Array<[string, number]> {
  const out: Array<[string, number]> = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && (bits[i] ?? 0) === (bits[start] ?? 0)) continue
    out.push([text.slice(start, i), bits[start] ?? 0])
    start = i
  }
  return out
}

export interface DiffView {
  /** Rewrite runs: bit 1 = newly written, 2 = kept verbatim, 4 = number not in the draft. */
  out: Array<[string, number]>
  /** Draft runs: bit 1 = removed/changed, 2 = kept verbatim, 4 = number missing from the rewrite. */
  draft: Array<[string, number]>
  ratio: number | undefined
}

/** Everything a card needs to colour a draft/rewrite pair. */
export function diffView(draft: string, out: string, opts: { showDiff: boolean; keep: readonly string[]; missingNumbers?: readonly string[]; addedNumbers?: readonly string[] }): DiffView {
  const aTok = tokenize(draft)
  const bTok = tokenize(out)
  const d = diffTokens(aTok, bTok)
  const ob = new Uint8Array(out.length)
  const db = new Uint8Array(draft.length)
  if (d && opts.showDiff) { markBits(bTok, d.b, ob, 1); markBits(aTok, d.a, db, 1) }
  literalBits(out, opts.keep, ob, 2)
  literalBits(draft, opts.keep, db, 2)
  // The host reports numbers as spelled in the text (e.g. "1,250,000", "3万"): mark them literally.
  literalBits(draft, opts.missingNumbers ?? [], db, 4)
  literalBits(out, opts.addedNumbers ?? [], ob, 4)
  return { out: runs(out, ob), draft: runs(draft, db), ratio: d ? d.ratio : undefined }
}
