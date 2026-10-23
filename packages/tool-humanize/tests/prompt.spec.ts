import { describe, expect, it } from 'vitest'
import { FINGERPRINT, INSTR, SAMPLING, SEP, buildPrompt, nPredictFor, promptFingerprint, pyStrip } from '../src/prompt.ts'

describe('prompt building', () => {
  it('matches the official fingerprint cc51d66b4c593fbe', () => {
    expect(FINGERPRINT).toBe('cc51d66b4c593fbe')
    expect(promptFingerprint()).toBe(FINGERPRINT)
  })

  it('is INSTR + \\n\\n + draft.strip() + \\n\\n### Rewritten:\\n\\n', () => {
    expect(buildPrompt('  \n Hello world. \t\n')).toBe(`${INSTR}\n\nHello world.\n\n### Rewritten:\n\n`)
    expect(SEP).toBe('\n\n### Rewritten:\n\n')
    expect(INSTR.startsWith('Rewrite the text below so it reads like a person wrote it, not a language model.\n\n')).toBe(true)
    expect(INSTR.endsWith('Every fact, number, unit, date, name and quotation must survive unchanged.')).toBe(true)
  })

  it('strips like Python str.strip()', () => {
    expect(pyStrip('\x1c\u3000 a b \u2029')).toBe('a b')
    expect(pyStrip('\ufeffa')).toBe('\ufeffa') // Python does not strip a BOM
  })

  it('uses the evaluated sampling and the app n_predict rule', () => {
    expect(SAMPLING).toEqual({ temperature: 1.0, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1.0 })
    expect(nPredictFor(10)).toBe(256)
    expect(nPredictFor(400)).toBe(1000)
    expect(nPredictFor(5000)).toBe(2048)
  })
})
