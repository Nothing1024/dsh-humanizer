/**
 * Parity with the official Python implementation: tests/fixtures/hz_text.json was produced by
 * running humanizer/hz_text.py (upstream revision 7dd4be9) on the same inputs.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  addedNumbers, check, copyRate, cutLong, languageDrift, missingNumbers, plan, render, scaled, score, Sizer, splitLeadin,
} from '../src/text.ts'

const fx = JSON.parse(readFileSync(new URL('./fixtures/hz_text.json', import.meta.url), 'utf8')) as {
  plans: Record<string, { input: string; units: Array<{ id: number; text: string; kind: string; line: number }>; kept: Record<string, number>; blocks: Array<[string, number, number, number, string]>; render_identity: string; render_upper: string }>
  numbers: Array<{ draft: string; out: string; missing: string[]; added: string[] }>
  copy: Array<{ draft: string; out: string; rate: number }>
  drift: Array<{ draft: string; out: string; drift: boolean }>
  checks: Array<{ draft: string; out: string; copy: number; issues: string[]; missing: string[]; added: string[]; score: [number, number] }>
}

describe('chunking (hz_text.plan_text parity)', () => {
  for (const [name, want] of Object.entries(fx.plans)) {
    it(`plans "${name}" exactly like hz_text.py`, () => {
      const p = plan(want.input)
      expect(p.blocks.map((b) => [b.kind, b.start, b.end, b.level, b.indent])).toEqual(want.blocks)
      expect(p.units).toEqual(want.units)
      expect(p.kept).toEqual(want.kept)
      expect(render(p, new Map(p.units.map((u) => [u.id, u.text])))).toBe(want.render_identity)
      expect(render(p, new Map(p.units.map((u) => [u.id, `R${u.id}`])))).toBe(want.render_upper)
    })
  }

  it('keeps headings, code, tables, quotes and references out of the units', () => {
    const p = plan(fx.plans.md!.input)
    const sent = p.units.map((u) => u.text).join('\n')
    expect(sent).not.toContain('# Quarterly report')
    expect(sent).not.toContain('print("keep me 42")')
    expect(sent).not.toContain('| a | b |')
    expect(sent).not.toContain('Smith, J.')
  })

  it('cuts an over-long paragraph into balanced pieces under ~350 words / 600 汉字', () => {
    const sizer = new Sizer()
    const en = cutLong(fx.plans.long_en!.input, sizer)
    expect(en.length).toBeGreaterThan(1)
    for (const piece of en) expect(sizer.size(piece)).toBeLessThanOrEqual(350)
    expect(en.join(' ')).toBe(fx.plans.long_en!.input.trim())
    const zh = cutLong(fx.plans.long_zh!.input, sizer)
    expect(zh.length).toBeGreaterThan(1)
    expect(zh.join('')).toBe(fx.plans.long_zh!.input)
  })

  it('keeps a list item lead-in verbatim', () => {
    expect(splitLeadin('**Enterprise:** We signed 48 contracts')).toEqual(['**Enterprise:** ', 'We signed 48 contracts'])
    expect(splitLeadin('背景：这是一个说明')).toEqual(['背景：', '这是一个说明'])
  })

  it('round-trips CRLF input', () => {
    const p = plan('Hello there, this is a fine paragraph with words.\r\n\r\n# H\r\n')
    expect(render(p, new Map([[1, 'X']]))).toBe('X\r\n\r\n# H\r\n')
  })
})

describe('number check (hz_text.missing_numbers / added_numbers parity)', () => {
  for (const c of fx.numbers) {
    it(`${c.draft} → ${c.out}`, () => {
      expect(missingNumbers(c.draft, c.out)).toEqual(c.missing)
      expect(addedNumbers(c.draft, c.out)).toEqual(c.added)
    })
  }
  it('scales exactly', () => {
    expect(scaled('31.7', 4)).toBe('317000')
    expect(scaled('1.5', 8)).toBe('150000000')
    expect(scaled('480', 3)).toBe('480000')
    expect(scaled('0.25', 3)).toBe('250')
  })
})

describe('copy rate and language drift', () => {
  for (const c of fx.copy) {
    it(`copy rate ${c.rate.toFixed(3)}`, () => {
      expect(copyRate(c.draft, c.out)).toBeCloseTo(c.rate, 10)
    })
  }
  for (const c of fx.drift) {
    it(`drift=${c.drift}: ${c.draft.slice(0, 20)}…`, () => {
      expect(languageDrift(c.draft, c.out)).toBe(c.drift)
    })
  }

  it('ignores kept literals when judging the language', () => {
    const zh = '星火计划团队在本季度成功交付了三个关键版本，显著提升了用户满意度和参与度。'
    const en = '星火计划 shipped three key releases this quarter, and users are noticeably happier and more engaged than before.'
    expect(languageDrift(zh, en)).toBe(false) // 4 Han chars from the kept name hid the drift
    expect(languageDrift(zh, en, ['星火计划'])).toBe(true)
    expect(languageDrift(zh, '星火计划这个季度交付了三个关键版本，用户明显更满意了。', ['星火计划'])).toBe(false)
    const enDraft = 'Our 星火计划 team shipped three releases and support got much faster in every single region this year.'
    expect(languageDrift(enDraft, 'The 星火计划 team put out three releases, and support is quicker everywhere now.', ['星火计划'])).toBe(false)
  })
})

describe('check()', () => {
  for (const c of fx.checks) {
    it(`issues ${c.issues.join(',')}`, () => {
      const got = check(c.draft, c.out)
      expect(got.issues).toEqual(c.issues)
      expect(got.copy).toBeCloseTo(c.copy, 3)
      expect(got.missingNumbers).toEqual(c.missing)
      expect(got.addedNumbers).toEqual(c.added)
      expect(score(got)).toEqual(c.score)
    })
  }
})
