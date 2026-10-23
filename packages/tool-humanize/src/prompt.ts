/**
 * The exact prompt the humanizer model was trained with. Verbatim copy of the official
 * `humanizer/promptfmt.py` (sgaofen/humanizer-local-model, Apache-2.0), which the repo pins with
 * the fingerprint sha256(build_prompt('X'))[:16] == cc51d66b4c593fbe in three places (Python,
 * Go launcher, web app). The model is a text-completion model: no chat template, no system prompt.
 * @module dsh-tool-humanize/prompt
 */
import { createHash } from 'node:crypto'

export const INSTR = 'Rewrite the text below so it reads like a person wrote it, not a language model.\n'
  + '\n'
  + 'Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\n'
  + 'throat-clearing, and any sentence that only announces what comes next.\n'
  + 'Prefer the concrete word over the abstract one. It is fine to sound uneven.\n'
  + '\n'
  + 'Every fact, number, unit, date, name and quotation must survive unchanged.'

/** The real switch the model keys on. Never use `###` as a stop string: generation ends at EOS. */
export const SEP = '\n\n### Rewritten:\n\n'

/** Official fingerprint of the prompt format (promptfmt.fingerprint()). */
export const FINGERPRINT = 'cc51d66b4c593fbe'

// Python str.isspace() whitespace (JS trim() differs: it strips \ufeff and keeps \x1c-\x1f, \x85).
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g')

/** Exactly Python's `draft.strip()` (port of app/web/js/text.js pyStrip). */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP, '')
}

/** prompt = INSTR + "\n\n" + draft.strip() + "\n\n### Rewritten:\n\n". Never build it anywhere else. */
export function buildPrompt(draft: string): string {
  return INSTR + '\n\n' + pyStrip(draft) + SEP
}

export function promptFingerprint(): string {
  return createHash('sha256').update(buildPrompt('X'), 'utf8').digest('hex').slice(0, 16)
}

/** Sampling the model was evaluated with. Every key is set on purpose (llama-server defaults differ). */
export const SAMPLING = Object.freeze({ temperature: 1.0, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1.0 })

/** n_predict = clamp(draft tokens × 2.5, 256, 2048) — same rule as the app and hz. */
export const N_PREDICT = Object.freeze({ factor: 2.5, min: 256, max: 2048 })

export function nPredictFor(draftTokens: number, max: number = N_PREDICT.max): number {
  return Math.min(max, Math.max(N_PREDICT.min, Math.ceil(draftTokens * N_PREDICT.factor)))
}

/** hz's estimate when /tokenize is unavailable. */
export function estimateTokens(latinWords: number, cjkChars: number): number {
  return Math.trunc(latinWords * 1.4 + cjkChars * 1.1) + 8
}
