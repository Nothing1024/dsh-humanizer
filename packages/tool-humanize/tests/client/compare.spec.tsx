import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { HumanizerPanel } from '../../src/client/Panel.tsx'
import { HumanizerStore, canCompare, comparing, humanizerStore } from '../../src/client/store.ts'
import { diffView, runs } from '../../src/client/diff.ts'

const c = (text: string, extra: Record<string, unknown> = {}): never => ({ text, copyRate: 0.3, issues: [], missingNumbers: [], addedNumbers: [], missingUrls: [], languageResampled: 0, keepTries: 1, seconds: 2, ...extra }) as never

function seed(store: HumanizerStore, draft: string, pieces: Array<{ draft: string; cands: string[]; extra?: Record<string, unknown> }>, keep: string[] = []): void {
  store.setDraft(draft)
  store.setLeftMode('compare')
  store.apply({ event: 'job', data: { jobId: `j${Math.random()}`, nSamples: 2, units: pieces.map((p, i) => ({ id: i + 1, kind: 'prose', line: i * 2 + 1, draft: p.draft })), keepActive: keep, keepIgnored: [], kept: {}, document: { text: '', warnings: [], done: 0, total: pieces.length } } } as never)
  // the job view remembers the draft it rewrote
  ;(store as unknown as { set(p: object): void }).set({ job: { ...store.getSnapshot().job!, draft } })
  pieces.forEach((p, i) => {
    store.apply({ event: 'piece', data: { unitId: i + 1, piece: { id: i + 1, kind: 'prose', line: i * 2 + 1, draft: p.draft, words: 5, candidates: p.cands.map((t) => c(t, p.extra)), best: 0, chosen: 0, seconds: 1 } } } as never)
  })
}

const html = (): string => renderToString(createElement(HumanizerPanel)).replaceAll('<!-- -->', '')
const leftPane = (h: string): string => h.slice(h.indexOf('data-side="left"'), h.indexOf('data-side="right"'))
const rightPane = (h: string): string => h.slice(h.indexOf('data-side="right"'))
const spans = (h: string, cls: string): string[] => [...h.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, 'g'))].map((m) => m[1]!)

describe('side-by-side 对比 view', () => {
  it('marks deletions on the left and insertions on the right from one diff, per chunk', () => {
    const s = humanizerStore()
    const d1 = 'In today\'s fast-paced world, our team successfully delivered 3 key releases.'
    const d2 = '星火计划在今天这个快节奏的时代，显著提升了用户满意度。'
    seed(s, `${d1}\n\n${d2}`, [
      { draft: d1, cands: ['Our team shipped 3 key releases this quarter.', 'We shipped 3 releases.'] },
      { draft: d2, cands: ['星火计划这段时间让用户满意了不少。'] },
    ], ['星火计划'])
    expect(comparing(s.getSnapshot())).toBe(true)
    const h = html()
    const L = leftPane(h)
    const R = rightPane(h)
    expect(h).not.toContain('<textarea')
    expect(L).toContain('原文 · 第 1/2 段')
    expect(L).toContain('data-pair="1"')
    expect(R).toContain('data-pair="1"')
    // left: removed words in red; right: new words in green — the same pair
    const del = spans(L, 'hz-del').join('|')
    const ins = spans(R, 'hz-ins').join('|')
    expect(del).toMatch(/fast-paced/)
    expect(del).not.toMatch(/releases/)
    expect(ins).toMatch(/shipped/)
    expect(L).not.toContain('hz-ins')
    expect(R).not.toContain('hz-del')
    // keep terms stay blue on both sides
    expect(L).toContain('<span class="hz-fact">星火计划</span>')
    expect(R).toContain('<span class="hz-fact">星火计划</span>')
    // CJK by character: shared characters are not marked, so not the whole sentence is red
    const zhDel = spans(L.slice(L.indexOf('原文 · 第 2/2 段')), 'hz-del').join('')
    expect(zhDel.length).toBeGreaterThan(0)
    expect(zhDel.length).toBeLessThan(d2.length - 6)
    expect(zhDel).not.toContain('用户')
    // the per-card 原文 toggle gives way to the left pane
    expect(R).not.toContain('>原文</button>')
    expect(h).toContain('✎ 编辑原稿')
    expect(h).toMatch(/aria-selected="true" class="on"[^>]*>对比/)
  })

  it('follows the chosen candidate and 显示改动 controls both sides', () => {
    const s = humanizerStore()
    const d = 'Our team shipped 3 releases this year.'
    seed(s, d, [{ draft: d, cands: ['Our team shipped 3 releases this year, again.', 'We put out three things.'] }])
    const del0 = spans(leftPane(html()), 'hz-del')
    expect(del0).toEqual([])
    ;(s as unknown as { set(p: object): void }).set({ job: { ...s.getSnapshot().job!, units: s.getSnapshot().job!.units.map((u) => ({ ...u, chosen: 1 })) } })
    const h1 = html()
    expect(spans(leftPane(h1), 'hz-del').join(' ')).toMatch(/team shipped/)
    expect(leftPane(h1)).toContain('对照候选 2')
    s.setShowDiff(false)
    const h2 = html()
    expect(h2).not.toContain('hz-del')
    expect(h2).not.toContain('hz-ins')
    s.setShowDiff(true)
  })

  it('全文 view diffs the whole draft against the assembled rewrite', () => {
    const s = humanizerStore()
    const d = 'Intro line.\n\nThe tool is very useful and helps teams.'
    seed(s, d, [{ draft: 'The tool is very useful and helps teams.', cands: ['Teams find the tool handy.'] }])
    s.apply({ event: 'document', data: { text: 'Intro line.\n\nTeams find the tool handy.', warnings: [], done: 1, total: 1 } } as never)
    s.setView('document')
    const h = html()
    expect(leftPane(h)).toContain('data-pair="all"')
    expect(spans(leftPane(h), 'hz-del').join(' ')).toMatch(/very useful/)
    expect(spans(leftPane(h), 'hz-del').join(' ')).not.toMatch(/Intro/)
    expect(spans(rightPane(h), 'hz-ins').join(' ')).toMatch(/handy/)
    s.setView('pieces')
  })

  it('switches back to editing, and only compares while the draft is the rewritten one', () => {
    const s = humanizerStore()
    const d = 'Some text to rewrite here.'
    seed(s, d, [{ draft: d, cands: ['Text, rewritten.'] }])
    s.setLeftMode('edit')
    expect(html()).toContain('<textarea')
    s.setLeftMode('compare')
    expect(html()).not.toContain('<textarea')
    s.setDraft(`${d} more`)
    expect(canCompare(s.getSnapshot())).toBe(false)
    const h = html()
    expect(h).toContain('<textarea')
    expect(h).toMatch(/disabled=""[^>]*>对比/)
    s.clearDraft()
    expect(s.getSnapshot().leftMode).toBe('edit')
  })
})

describe('diff granularity', () => {
  it('splits Chinese by character and English by word', () => {
    const v = diffView('我们的团队在本季度成功交付了三个关键版本', '团队这个季度交付了三个版本', { showDiff: true, keep: [] })
    const del = v.draft.filter(([, b]) => b & 1).map(([t]) => t)
    expect(del.join('')).not.toContain('交付')
    expect(del.join('').length).toBeLessThan(12)
    const e = diffView('The quick brown fox jumps', 'The slow brown fox leaps', { showDiff: true, keep: [] })
    expect(e.draft.filter(([, b]) => b & 1).map(([t]) => t.trim())).toEqual(['quick', 'jumps'])
    expect(runs('ab', new Uint8Array([1, 1]))).toEqual([['ab', 1]])
  })
})
