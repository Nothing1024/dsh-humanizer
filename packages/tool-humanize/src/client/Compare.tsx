/**
 * Side-by-side diff for the 去AI味 panel: the left pane's read-only 对比 view of the original,
 * chunk by chunk, aligned with the rewrite cards on the right.
 *
 * Both panes colour from ONE diff per chunk (diffView over the chunk's original and its currently
 * chosen candidate — the official app's approach: one token diff of the pair, deletions drawn on
 * the draft side, insertions on the rewrite side). In the 全文 view the pair is the whole draft
 * and the assembled rewrite. Paired blocks share a `data-pair` id; their heights are equalized so
 * the panes line up, scrolling is synced per chunk, and hovering/clicking one highlights/scrolls
 * the other.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { diffView } from './diff.ts'
import type { DiffView } from './diff.ts'
import type { State, UnitView } from './store.ts'

const KIND_LABEL: Record<string, string> = { prose: '正文', item: '列表项', sentences: '长段' }

export const DRAFT_CLS: Record<number, string> = { 1: 'hz-del', 2: 'hz-fact', 4: 'hz-num' }
export const OUT_CLS: Record<number, string> = { 1: 'hz-ins', 2: 'hz-fact', 4: 'hz-num' }

export function Runs({ runs, cls }: { runs: Array<[string, number]>; cls: Record<number, string> }): ReactNode {
  return runs.map(([t, b], i) => {
    if (!b) return t
    const c = Object.entries(cls).filter(([bit]) => b & Number(bit)).map(([, name]) => name).join(' ')
    return <span key={i} className={c}>{t}</span>
  })
}

/** The candidate a chunk currently shows (chosen, else the latest). */
export function shownCandidate(u: UnitView): UnitView['candidates'][number] | undefined {
  return u.candidates[u.chosen] ?? u.candidates[u.candidates.length - 1]
}

/**
 * One diff per chunk for both panes, cached by its inputs so streaming updates of other chunks do
 * not recompute it.
 */
export function useUnitViews(s: State): Map<number, DiffView> {
  const cache = useRef(new Map<string, DiffView>())
  const jobId = s.job?.id
  useMemo(() => { cache.current.clear() }, [jobId])
  const keep = s.job?.keepActive ?? []
  const keepKey = keep.join('\u0000')
  return useMemo(() => {
    const out = new Map<number, DiffView>()
    const used = new Set<string>()
    for (const u of s.job?.units ?? []) {
      const c = shownCandidate(u)
      if (!c) continue
      const key = `${u.id}\u0001${s.showDiff ? 1 : 0}\u0001${keepKey}\u0001${c.missingNumbers.join(',')}\u0001${c.addedNumbers.join(',')}\u0001${u.draft}\u0001${c.text}`
      let v = cache.current.get(key)
      if (!v) {
        v = diffView(u.draft, c.text, { showDiff: s.showDiff, keep, missingNumbers: c.missingNumbers, addedNumbers: c.addedNumbers })
        cache.current.set(key, v)
      }
      used.add(key)
      out.set(u.id, v)
    }
    for (const k of cache.current.keys()) if (!used.has(k)) cache.current.delete(k)
    return out
  }, [s.job, s.showDiff, keepKey])
}

/** The 全文 pair: whole draft vs assembled rewrite (one diff for both panes). */
export function useDocumentView(s: State): DiffView | undefined {
  const docText = s.document?.text ?? ''
  return useMemo(() => (s.view === 'document' && s.job && docText
    ? diffView(s.job.draft, docText, { showDiff: s.showDiff, keep: s.job.keepActive })
    : undefined), [s.view, s.job, docText, s.showDiff])
}

function stateText(u: UnitView): string {
  if (u.state === 'running') return '改写中…'
  if (u.state === 'error') return '出错'
  if (u.state === 'done') return ''
  return '排队中'
}

/** Left pane 对比 view. */
export function CompareView({ s, views, doc, hot, onHot, onPick, paneRef }: {
  s: State
  views: Map<number, DiffView>
  doc: DiffView | undefined
  hot: string | undefined
  onHot: (id: string | undefined) => void
  onPick: (id: string) => void
  paneRef: MutableRefObject<HTMLDivElement | null>
}): ReactNode {
  const units = s.job?.units ?? []
  if (s.view === 'document') {
    return (
      <div className="hz-out hz-cmp" ref={paneRef} data-side="left">
        <div className="hz-text hz-full hz-orig" data-pair="all">
          {doc ? <Runs runs={doc.draft} cls={DRAFT_CLS} /> : s.job?.draft}
        </div>
      </div>
    )
  }
  return (
    <div className="hz-out hz-cmp" ref={paneRef} data-side="left">
      {units.length === 0
        ? <div className="hz-empty"><p className="hz-dim">没有需要改写的正文。</p></div>
        : units.map((u, i) => {
            const v = views.get(u.id)
            const id = String(u.id)
            const st = stateText(u)
            return (
              <article
                key={u.id}
                className={`hz-card hz-orig ${u.state}${hot === id ? ' hot' : ''}`}
                data-pair={id}
                onMouseEnter={() => { onHot(id) }}
                onMouseLeave={() => { onHot(undefined) }}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button') && !String(globalThis.getSelection?.() ?? '')) onPick(id) }}
              >
                <header className="hz-card-head">
                  <span className="hz-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="hz-card-title">原文 · 第 {i + 1}/{units.length} 段</span>
                  <span className="hz-dim">第 {u.line} 行 · {KIND_LABEL[u.kind] ?? u.kind}</span>
                  <span className="hz-grow" />
                  {st ? <span className="hz-dim">{st}</span> : null}
                  {u.candidates.length > 1 && v ? <span className="hz-dim" title="左侧按右侧当前选中的候选标出删改">对照候选 {u.chosen + 1}</span> : null}
                </header>
                <div className="hz-text">
                  {v ? <Runs runs={v.draft} cls={DRAFT_CLS} /> : u.draft}
                </div>
              </article>
            )
          })}
    </div>
  )
}

function blocks(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(':scope > [data-pair]')]
}

function match(pane: HTMLElement, id: string): HTMLElement | null {
  return pane.querySelector<HTMLElement>(`:scope > [data-pair="${CSS.escape(id)}"]`)
}

/**
 * Line up paired blocks (equal min-heights) and sync scrolling per chunk between two panes.
 * `active` = the 对比 view is showing; `deps` re-measure after content changes.
 */
export function usePairedPanes(left: MutableRefObject<HTMLDivElement | null>, right: MutableRefObject<HTMLDivElement | null>, active: boolean, deps: unknown[]): { pick: (id: string, from: 'left' | 'right') => void } {
  // Equalize heights after every content change and on resize.
  useLayoutEffect(() => {
    const a = left.current
    const b = right.current
    if (!active || !a || !b) return
    const measure = (): void => {
      const pairs: Array<[HTMLElement, HTMLElement]> = []
      for (const x of blocks(a)) {
        const y = match(b, x.dataset.pair!)
        if (y) pairs.push([x, y])
      }
      for (const [x, y] of pairs) { x.style.minHeight = ''; y.style.minHeight = '' }
      for (const [x, y] of pairs) {
        if (x.dataset.pair === 'all') continue
        const h = Math.max(x.offsetHeight, y.offsetHeight)
        x.style.minHeight = `${h}px`
        y.style.minHeight = `${h}px`
      }
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { requestAnimationFrame(measure) }) : undefined
    ro?.observe(a)
    ro?.observe(b)
    return () => {
      ro?.disconnect()
      for (const el of [...blocks(a), ...blocks(b)]) el.style.minHeight = ''
    }
  }, [active, ...deps])

  // Chunk-anchored scroll sync.
  useEffect(() => {
    const a = left.current
    const b = right.current
    if (!active || !a || !b) return
    let ignore: HTMLElement | undefined
    const sync = (src: HTMLElement, dst: HTMLElement): void => {
      if (ignore === src) { ignore = undefined; return }
      const top = src.scrollTop
      const anchor = blocks(src).find((el) => el.offsetTop + el.offsetHeight > top)
      let next: number
      if (!anchor) next = dst.scrollHeight
      else {
        const peer = match(dst, anchor.dataset.pair!)
        if (!peer) return
        const ratio = Math.max(0, (top - anchor.offsetTop) / Math.max(1, anchor.offsetHeight))
        next = peer.offsetTop + ratio * peer.offsetHeight - (anchor.offsetTop > top ? anchor.offsetTop - top : 0)
      }
      if (Math.abs(dst.scrollTop - next) < 1) return
      ignore = dst
      dst.scrollTop = next
    }
    const onA = (): void => { sync(a, b) }
    const onB = (): void => { sync(b, a) }
    a.addEventListener('scroll', onA, { passive: true })
    b.addEventListener('scroll', onB, { passive: true })
    return () => { a.removeEventListener('scroll', onA); b.removeEventListener('scroll', onB) }
  }, [active, left, right])

  const pick = useCallback((id: string, from: 'left' | 'right') => {
    const dst = (from === 'left' ? right : left).current
    const el = dst ? match(dst, id) : null
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    setTimeout(() => { el.classList.remove('flash') }, 900)
  }, [left, right])

  return { pick }
}
