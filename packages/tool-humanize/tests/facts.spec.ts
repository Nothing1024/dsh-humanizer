import { describe, expect, it } from 'vitest'
import { FactsLostError, activeFacts, locksIn, protectFacts, restoreFacts } from '../src/facts.ts'

describe('keep verbatim (app facts.js port)', () => {
  const draft = 'Acme Cloud grew fast. As Jane said, "ship it". Acme Cloud is great.'

  it('replaces every occurrence and merges overlaps', () => {
    const pd = protectFacts(draft, ['Acme Cloud', '"ship it"', 'missing'])
    expect(pd.text).toBe('[[HZ_LOCK_0]] grew fast. As Jane said, [[HZ_LOCK_1]]. [[HZ_LOCK_2]] is great.')
    expect(pd.facts).toEqual(['Acme Cloud', '"ship it"'])
    expect(activeFacts(['x', 'Acme Cloud', 'Acme Cloud', 3], draft)).toEqual(['Acme Cloud'])
  })

  it('restores placeholders, accepting changed bracket counts', () => {
    const pd = protectFacts(draft, ['Acme Cloud', '"ship it"'])
    const out = 'HZ_LOCK_0 is growing. Jane: [HZ_LOCK_1]! And [[ HZ_LOCK_2 ]] rocks.'
    expect(restoreFacts(out, pd)).toBe('Acme Cloud is growing. Jane: "ship it"! And Acme Cloud rocks.')
  })

  it('rejects a lost or duplicated placeholder', () => {
    const pd = protectFacts(draft, ['Acme Cloud'])
    expect(() => restoreFacts('[[HZ_LOCK_0]] only once', pd)).toThrow(FactsLostError)
    expect(() => restoreFacts('[[HZ_LOCK_0]] [[HZ_LOCK_0]] [[HZ_LOCK_1]]', pd)).toThrow(FactsLostError)
  })

  it('picks a prefix that is not in the draft and checks per piece', () => {
    const pd = protectFacts('HZ_LOCK_ is a word. Keep me.', ['Keep me'])
    expect(pd.prefix).toBe('_HZ_LOCK_')
    expect(locksIn('nothing here', pd)).toEqual([])
    expect(locksIn(pd.text, pd)).toHaveLength(1)
  })
})
