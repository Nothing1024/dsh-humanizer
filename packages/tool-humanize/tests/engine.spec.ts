import { describe, expect, it } from 'vitest'
import { humanize, clampSamples } from '../src/engine.ts'
import type { CompletionResult, HumanizerBackend } from '../src/client.ts'
import { serialize } from '../src/client.ts'
import { SEP, INSTR } from '../src/prompt.ts'

/** Scripted backend: each complete() pops the next reply (a function of the draft in the prompt). */
class FakeBackend implements HumanizerBackend {
  readonly label = 'fake'
  prompts: string[] = []
  active = 0
  maxActive = 0
  constructor(private readonly replies: Array<string | ((draft: string) => string) | { text: string; truncated: boolean }>, private readonly fallback?: (draft: string) => string) {}
  async tokenize(text: string): Promise<number> { return Math.ceil(text.length / 4) }
  async complete(prompt: string): Promise<CompletionResult> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((r) => setTimeout(r, 2))
    this.prompts.push(prompt)
    const draft = prompt.slice(INSTR.length + 2, -SEP.length)
    const next = this.replies.shift() ?? this.fallback
    this.active--
    if (next === undefined) throw new Error('no scripted reply')
    if (typeof next === 'function') return { text: next(draft), truncated: false, tokensPredicted: 10, ms: 1 }
    if (typeof next === 'string') return { text: next, truncated: false, tokensPredicted: 10, ms: 1 }
    return { ...next, tokensPredicted: 10, ms: 1 }
  }
}

const signal = new AbortController().signal
const EN = 'Our team shipped 3 releases in 2026 and support response times dropped to 4 hours across all regions.'
const GOOD_EN = 'Three releases went out in 2026. Support now answers within 4 hours, everywhere.'

describe('humanize engine', () => {
  it('builds the exact prompt and returns a clean rewrite', async () => {
    const b = new FakeBackend([GOOD_EN])
    const r = await humanize(EN, b, { signal })
    expect(b.prompts).toEqual([`${INSTR}\n\n${EN}${SEP}`])
    expect(r.text).toBe(GOOD_EN)
    expect(r.warnings).toEqual([])
    expect(r.requests).toBe(1)
  })

  it('resamples silently when an English draft comes back in Chinese (up to 3×)', async () => {
    const zh = '我们团队在二零二六年发布了三个版本，各地区的客服响应时间都缩短到了四个小时以内。'
    const b = new FakeBackend([zh, zh, GOOD_EN])
    const r = await humanize(EN, b, { signal })
    expect(r.text).toBe(GOOD_EN)
    expect(r.pieces[0]!.candidates[0]!.languageResampled).toBe(2)
    expect(r.requests).toBe(3)
    const b2 = new FakeBackend([zh, zh, zh, zh, GOOD_EN])
    const r2 = await humanize(EN, b2, { signal, retries: 0 })
    expect(r2.pieces[0]!.candidates[0]!.languageResampled).toBe(3)
    expect(r2.pieces[0]!.candidates[0]!.issues).toContain('language')
  })

  it('a kept Chinese term does not hide a Chinese draft rewritten in English', async () => {
    const ZH = '星火计划团队在本季度成功交付了三个关键版本，显著提升了用户满意度和参与度，各地区的客服响应时间也缩短到了四个小时以内。'
    const tok = (d: string): string => d.slice(0, d.indexOf('团队'))
    const english = (d: string): string => `${tok(d)} shipped three key releases this quarter, users are happier and more engaged, and support now answers within four hours in every region.`
    const chinese = (d: string): string => `${tok(d)}这个季度交付了三个关键版本，用户更满意、也更愿意参与了，各地客服现在四个小时内就能回复。`
    const b = new FakeBackend([english, english, chinese])
    const r = await humanize(ZH, b, { signal, keep: ['星火计划'] })
    const c = r.pieces[0]!.candidates[0]!
    expect(c.languageResampled).toBe(2)
    expect(c.text.startsWith('星火计划这个季度')).toBe(true)
    expect(c.issues).not.toContain('language')
    // all resamples drift → flagged instead of passing as "checks OK"
    const b2 = new FakeBackend([], english)
    const r2 = await humanize(ZH, b2, { signal, keep: ['星火计划'], retries: 0 })
    expect(r2.pieces[0]!.candidates[0]!.issues).toContain('language')
    expect(r2.pieces[0]!.candidates[0]!.text).toContain('星火计划')
  })

  it('retries once when the sample has a problem and keeps the better version', async () => {
    const b = new FakeBackend(['Releases went out. Support got faster.', GOOD_EN])
    const r = await humanize(EN, b, { signal })
    expect(r.pieces[0]!.candidates).toHaveLength(2)
    expect(r.pieces[0]!.chosen).toBe(1)
    expect(r.text).toBe(GOOD_EN)
  })

  it('reports missing numbers when every try loses them', async () => {
    const bad = 'Releases went out this year and support got a lot faster in every single region we serve.'
    const r = await humanize(EN, new FakeBackend([bad, bad]), { signal })
    expect(r.pieces[0]!.candidates[r.pieces[0]!.chosen]!.missingNumbers).toEqual(['3', '2026', '4'])
    expect(r.warnings.join('\n')).toContain('找不到这些数字：3、2026、4')
  })

  it('flags a copy rate above 0.5', async () => {
    const r = await humanize(EN, new FakeBackend([EN, EN]), { signal })
    expect(r.pieces[0]!.candidates[0]!.issues).toContain('copy')
    expect(r.warnings.join('\n')).toContain('照抄率 100%')
  })

  it('draws n candidates sequentially and assembles variants', async () => {
    const b = new FakeBackend([GOOD_EN, 'In 2026 we shipped 3 releases; support replies in 4 hours now.', GOOD_EN.replace('everywhere', 'in every region')])
    const r = await humanize(EN, b, { signal, nSamples: 3 })
    expect(r.pieces[0]!.candidates).toHaveLength(3)
    expect(r.variants).toHaveLength(3)
    expect(b.maxActive).toBe(1)
    expect(clampSamples(9)).toBe(4)
    expect(clampSamples(0)).toBe(1)
    expect(clampSamples(undefined)).toBe(1)
  })

  it('keeps protected spans verbatim and rewrites again when a placeholder is lost', async () => {
    const draft = 'Acme Cloud shipped 3 releases in 2026, and as Jane said, "ship it or skip it" became the motto.'
    const b = new FakeBackend([
      (d) => d.replace(/\[\[HZ_LOCK_\d\]\]/g, 'something'), // lost placeholders → retry
      () => `In 2026 [[HZ_LOCK_0]] put out 3 releases. Jane's line, [HZ_LOCK_1], stuck.`,
    ])
    const r = await humanize(draft, b, { signal, keep: ['Acme Cloud', '"ship it or skip it"'] })
    expect(b.prompts[0]).toContain('[[HZ_LOCK_0]]')
    expect(b.prompts[0]).not.toContain('Acme Cloud')
    expect(r.text).toBe('In 2026 Acme Cloud put out 3 releases. Jane\'s line, "ship it or skip it", stuck.')
    expect(r.pieces[0]!.candidates[0]!.keepTries).toBe(2)
    expect(r.keepActive).toEqual(['Acme Cloud', '"ship it or skip it"'])
  })

  it('falls back to the original piece when keep fails every time', async () => {
    const draft = 'Acme Cloud shipped 3 releases in 2026 and everyone was really happy about it in the end.'
    const lost = (): string => 'Someone shipped 3 releases in 2026 and people were happy.'
    const r = await humanize(draft, new FakeBackend([], lost), { signal, keep: ['Acme Cloud'] })
    expect(r.text).toBe(draft)
    expect(r.warnings.join('\n')).toContain('原样保留')
    expect(r.requests).toBe(6) // 3 keep tries × (1 sample + 1 retry)
  })

  it('rewrites Markdown prose only and keeps structure', async () => {
    const md = '# Title\n\nThe first paragraph explains what the product does for its users in detail.\n\n```js\nconst x = 1\n```\n\n- **Speed:** The new engine answers most questions in under 2 seconds on a laptop, which is fast.\n'
    const b = new FakeBackend([], (d) => d.toUpperCase())
    const r = await humanize(md, b, { signal, retries: 0 })
    expect(r.text).toBe('# Title\n\nTHE FIRST PARAGRAPH EXPLAINS WHAT THE PRODUCT DOES FOR ITS USERS IN DETAIL.\n\n```js\nconst x = 1\n```\n\n- **Speed:** THE NEW ENGINE ANSWERS MOST QUESTIONS IN UNDER 2 SECONDS ON A LAPTOP, WHICH IS FAST.\n')
    expect(r.pieces).toHaveLength(2)
    expect(r.kept).toEqual({ heading: 1, code: 1 })
  })

  it('warns about keep terms that are not in the text', async () => {
    const r = await humanize(EN, new FakeBackend([GOOD_EN]), { signal, keep: ['Nope'] })
    expect(r.keepIgnored).toEqual(['Nope'])
    expect(r.warnings.join('\n')).toContain('「Nope」')
  })

  it('serializes concurrent calls per endpoint (-np 1)', async () => {
    let active = 0
    let max = 0
    const job = async (): Promise<void> => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active-- }
    await Promise.all([serialize('k', job), serialize('k', job), serialize('k', job)])
    expect(max).toBe(1)
  })
})
