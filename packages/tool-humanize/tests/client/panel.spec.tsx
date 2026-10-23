import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { HumanizerPanel } from '../../src/client/Panel.tsx'
import { humanizerStore } from '../../src/client/store.ts'
import { apply, PANEL_ID } from '../../src/client/index.tsx'

describe('panel', () => {
  it('renders the empty editor', () => {
    const html = renderToString(createElement(HumanizerPanel))
    expect(html).toContain('去 AI 味')
    expect(html).toContain('草稿')
    expect(html).toContain('改写会出现在这里')
    expect(html).toContain('原样保留')
  })

  it('renders pieces with candidate tabs, highlights and check chips', () => {
    const s = humanizerStore()
    s.setDraft('Our team shipped 3 releases.')
    s.apply({ event: 'job', data: { jobId: 'j', nSamples: 2, units: [{ id: 1, kind: 'prose', line: 1, draft: 'Our team shipped 3 releases.' }], keepActive: [], keepIgnored: [], kept: {}, document: { text: '', warnings: [], done: 0, total: 1 } } })
    const c = (text: string, missing: string[] = []): never => ({ text, copyRate: 0.3, issues: missing.length ? ['missing_numbers'] : [], missingNumbers: missing, addedNumbers: [], missingUrls: [], languageResampled: 0, keepTries: 1, seconds: 2 }) as never
    s.apply({ event: 'piece', data: { unitId: 1, piece: { id: 1, kind: 'prose', line: 1, draft: 'Our team shipped 3 releases.', words: 5, candidates: [c('We put out 3 releases.'), c('We put out a few releases.', ['3'])], best: 0, chosen: 0, seconds: 4 } } })
    const html = renderToString(createElement(HumanizerPanel)).replaceAll('<!-- -->', '')
    expect(html).toContain('第 1/1 段')
    expect(html).toContain('1★')
    expect(html).toContain('hz-ins')
    expect(html).toContain('重新生成')
    expect(html).toContain('检查通过')
  })

  it('registers a main panel and a sidebar row', () => {
    const regs: Array<Record<string, unknown>> = []
    apply({
      slots: { inject: (_n, fn) => { fn() }, register: (o) => { regs.push(o); return () => {} } },
      effect: () => {},
    })
    expect(regs).toEqual([
      { name: 'main', key: PANEL_ID },
      { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '去 AI 味' },
    ])
  })
})
