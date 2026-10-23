import { describe, expect, it } from 'vitest'
import { HumanizerStore } from '../../src/client/store.ts'
import { sseParser } from '../../src/client/api.ts'
import type { StreamEvent, WireCandidate } from '../../src/client/api.ts'
import { diffView, diffTokens, tokenize } from '../../src/client/diff.ts'

const cand = (text: string, extra: Partial<WireCandidate> = {}): WireCandidate => ({ text, copyRate: 0.2, issues: [], missingNumbers: [], addedNumbers: [], missingUrls: [], languageResampled: 0, keepTries: 1, seconds: 1, ...extra })

describe('UI store', () => {
  it('follows a job stream: pending → running (live text) → done with candidates', () => {
    const s = new HumanizerStore({ draft: 'A draft.' })
    const doc = { text: 'A draft.', warnings: [], done: 0, total: 1 }
    const events: StreamEvent[] = [
      { event: 'job', data: { jobId: 'j', nSamples: 2, units: [{ id: 1, kind: 'prose', line: 1, draft: 'A draft.' }], keepActive: [], keepIgnored: [], kept: {}, document: doc } },
      { event: 'unit', data: { unitId: 1, state: 'running', position: 0, count: 1 } },
      { event: 'sample', data: { unitId: 1, index: 0 } },
      { event: 'partial', data: { unitId: 1, index: 0, text: 'Some' } },
    ]
    for (const e of events) s.apply(e)
    expect(s.getSnapshot().job!.units[0]!.state).toBe('running')
    expect(s.getSnapshot().job!.units[0]!.live).toEqual({ index: 0, text: 'Some' })
    s.apply({ event: 'candidate', data: { unitId: 1, index: 0, candidate: cand('Some text.') } })
    s.apply({ event: 'piece', data: { unitId: 1, piece: { id: 1, kind: 'prose', line: 1, draft: 'A draft.', words: 2, candidates: [cand('Some text.'), cand('Other.')], best: 1, chosen: 1, seconds: 2 } } })
    s.apply({ event: 'done', data: { text: 'Other.', warnings: [], done: 1, total: 1, cancelled: false, requests: 2, seconds: 2 } })
    const st = s.getSnapshot()
    expect(st.job!.units[0]).toMatchObject({ state: 'done', best: 1, chosen: 1 })
    expect(st.job!.units[0]!.candidates).toHaveLength(2)
    expect(st.document!.text).toBe('Other.')
    expect(st.stats).toEqual({ requests: 2, seconds: 2, cancelled: false })
  })

  it('keeps keep-terms unique and trimmed', () => {
    const s = new HumanizerStore({})
    s.addKeep(' 星火计划 ')
    s.addKeep('星火计划')
    s.addKeep('  ')
    expect(s.getSnapshot().keep).toEqual(['星火计划'])
    s.removeKeep('星火计划')
    expect(s.getSnapshot().keep).toEqual([])
  })

  it('parses SSE frames split across chunks', () => {
    const got: StreamEvent[] = []
    const p = sseParser((e) => got.push(e))
    p.push('event: document\ndata: {"text":"a",')
    p.push('"warnings":[],"done":1,"total":1}\n\n: hb\n\nevent: err')
    p.push('or\ndata: {"message":"x"}\n\n')
    p.end()
    expect(got.map((e) => e.event)).toEqual(['document', 'error'])
  })
})

describe('display diff (port of app/web/js/diff.js)', () => {
  it('marks rewritten words and keeps equal ones', () => {
    const d = diffTokens(tokenize('The quick brown fox'), tokenize('The slow brown fox'))!
    expect(Array.from(d.b)).toEqual([0, 1, 0, 0])
    expect(Array.from(d.a)).toEqual([0, 1, 0, 0])
  })

  it('colours kept terms and missing numbers', () => {
    const v = diffView('星火计划 增长了 12.5%', '星火计划 涨了不少', { showDiff: true, keep: ['星火计划'], missingNumbers: ['12.5%'] })
    expect(v.out[0]).toEqual(['星火计划', 2])
    expect(v.draft.some(([t, b]) => t.includes('12.5') && (b & 4) !== 0)).toBe(true)
  })
})
