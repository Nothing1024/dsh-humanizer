/**
 * "Keep verbatim" spans — port of the official app's Create fact (app/web/js/facts.js,
 * sgaofen/humanizer-local-model, Apache-2.0). Before the rewrite each kept passage is replaced by a
 * placeholder `[[HZ_LOCK_n]]`; the model only sees the placeholder. Afterwards every placeholder
 * must come back exactly once, then it is swapped back to the original text. Otherwise the piece is
 * rewritten again (FACT_TRIES); a version that lost a kept passage is never published.
 * Placeholder shape and try count were measured by the upstream authors on the real model
 * (32 drafts × 2 runs, 130 kept spans): all came back within 2 tries.
 * @module dsh-tool-humanize/facts
 */

export const FACT_TRIES = 3
export const MAX_FACTS = 50

export interface Lock {
  token: string
  value: string
}

export interface ProtectedDraft {
  text: string
  locks: Lock[]
  facts: string[]
  prefix: string
}

/** Facts are literal draft passages, not additional model instructions. */
export function activeFacts(facts: readonly unknown[] | undefined, draft: string): string[] {
  const list = Array.isArray(facts) ? facts : []
  return [...new Set(list.filter((f): f is string => typeof f === 'string' && f.trim() !== '' && draft.includes(f)))].slice(0, MAX_FACTS)
}

export function protectFacts(draft: string, facts: readonly unknown[] | undefined): ProtectedDraft {
  const active = activeFacts(facts, draft)
  let prefix = 'HZ_LOCK_'
  while (draft.includes(prefix)) prefix = '_' + prefix
  const ranges: Array<{ start: number; end: number }> = []
  for (const fact of active) {
    for (let start = draft.indexOf(fact); start >= 0; start = draft.indexOf(fact, start + 1)) {
      ranges.push({ start, end: start + fact.length })
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  let text = ''
  let cursor = 0
  const locks = merged.map((range, i) => {
    const token = `[[${prefix}${i}]]`
    const value = draft.slice(range.start, range.end)
    text += draft.slice(cursor, range.start) + token
    cursor = range.end
    return { token, value }
  })
  text += draft.slice(cursor)
  return { text, locks, facts: active, prefix }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The model sometimes writes [[HZ_LOCK_0]] as [HZ_LOCK_0] or HZ_LOCK_0 — accept those too. */
function lockPattern(prefix: string, i: number): RegExp {
  return new RegExp(`(?:\\[{1,2}[ \\t]*)?${escapeRe(prefix)}${i}(?!\\d)(?:[ \\t]*\\]{1,2})?`, 'g')
}

/** Index of each lock in the full protected draft (the number in its token). */
export function lockIndex(lock: Lock, prefix: string): number {
  return Number(lock.token.slice(2 + prefix.length, -2))
}

/** Locks whose placeholder occurs in `piece` (a chunk of the protected draft). */
export function locksIn(piece: string, pd: ProtectedDraft): Lock[] {
  return pd.locks.filter((l) => piece.includes(l.token))
}

export class FactsLostError extends Error {
  constructor() {
    super('factsLost')
  }
}

/**
 * Swap placeholders back. strict: every lock must appear exactly once, no stray prefix may remain,
 * and every fact must be present afterwards — else FactsLostError.
 */
export function restoreFacts(text: string, pd: ProtectedDraft, strict = true, locks: Lock[] = pd.locks): string {
  let restored = text
  for (const lock of locks) {
    const re = lockPattern(pd.prefix, lockIndex(lock, pd.prefix))
    if (strict && (restored.match(re) ?? []).length !== 1) throw new FactsLostError()
    restored = restored.replace(re, () => lock.value)
  }
  if (strict && locks.length > 0 && restored.includes(pd.prefix)) throw new FactsLostError()
  return restored
}
