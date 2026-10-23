/**
 * UI state for the 去AI味 panel: one module-level store, so the draft, the running job and its
 * results survive switching panels in dsh web. All model work happens on the host; this keeps
 * what the streams report and forwards the user's actions.
 */
import { getJson, importFile, postJson, postStream } from './api.ts'
import type { Info, StreamEvent, WireCandidate, WireDocument, WireUnit } from './api.ts'

export type UnitState = 'pending' | 'running' | 'done' | 'error'

export interface UnitView extends WireUnit {
  state: UnitState
  candidates: WireCandidate[]
  best: number
  chosen: number
  /** Index of the sample being written, and its text so far. */
  live?: { index: number; text: string } | undefined
  seconds?: number | undefined
}

export interface JobView {
  id: string
  nSamples: number
  units: UnitView[]
  keepActive: string[]
  keepIgnored: string[]
  kept: Record<string, number>
  /** Draft text the job was started from (to flag edits made afterwards). */
  draft: string
}

export interface RunView {
  kind: 'job' | 'regen'
  unitId?: number | undefined
  startedAt: number
  /** Running unit position / count for the progress line. */
  position: number
  count: number
}

export interface State {
  draft: string
  keep: string[]
  nSamples: number
  /** The user picked nSamples in this browser; otherwise it follows the settings default. */
  samplesPicked: boolean
  showDiff: boolean
  view: 'pieces' | 'document'
  /** The panel's main view or its 设置 view. */
  page: 'main' | 'settings'
  /** Left pane: the editable draft, or the read-only 对比 view of the original (needs a current job). */
  leftMode: 'compare' | 'edit'
  info?: Info | undefined
  health?: { ok: boolean; message?: string | undefined } | undefined
  job?: JobView | undefined
  document?: WireDocument | undefined
  run?: RunView | undefined
  stats?: { requests: number; seconds: number; cancelled: boolean } | undefined
  error?: string | undefined
  toast?: { text: string; kind: 'ok' | 'err' | '' ; at: number } | undefined
  importing: boolean
}

const LS = 'dsh.humanizer.ui.v1'

function load(): Partial<State> {
  try {
    const raw = globalThis.localStorage?.getItem(LS)
    if (!raw) return {}
    const v = JSON.parse(raw) as Partial<State>
    return {
      ...typeof v.draft === 'string' ? { draft: v.draft } : {},
      ...Array.isArray(v.keep) ? { keep: v.keep.filter((k) => typeof k === 'string') } : {},
      ...typeof v.nSamples === 'number' && v.samplesPicked === true ? { nSamples: Math.min(4, Math.max(1, Math.trunc(v.nSamples))), samplesPicked: true } : {},
      ...typeof v.showDiff === 'boolean' ? { showDiff: v.showDiff } : {},
    }
  } catch { return {} }
}

function save(s: State): void {
  try {
    globalThis.localStorage?.setItem(LS, JSON.stringify({ draft: s.draft, keep: s.keep, nSamples: s.nSamples, samplesPicked: s.samplesPicked, showDiff: s.showDiff }))
  } catch { /* storage full / disabled */ }
}

export class HumanizerStore {
  private state: State
  private readonly subs = new Set<() => void>()
  private controller: AbortController | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined

  constructor(initial: Partial<State> = load()) {
    this.state = { draft: '', keep: [], nSamples: 1, samplesPicked: false, showDiff: true, view: 'pieces', page: 'main', leftMode: 'edit', importing: false, ...initial }
  }

  getSnapshot = (): State => this.state
  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn) } }

  private set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...p }
    if ('draft' in p || 'keep' in p || 'nSamples' in p || 'samplesPicked' in p || 'showDiff' in p) save(this.state)
    for (const fn of this.subs) fn()
  }

  private updateUnit(unitId: number, f: (u: UnitView) => UnitView): void {
    this.set((s) => s.job ? { job: { ...s.job, units: s.job.units.map((u) => (u.id === unitId ? f(u) : u)) } } : {})
  }

  toast(text: string, kind: 'ok' | 'err' | '' = ''): void {
    clearTimeout(this.toastTimer)
    this.set({ toast: { text, kind, at: Date.now() } })
    this.toastTimer = setTimeout(() => { this.set({ toast: undefined }) }, 2600)
  }

  setDraft(draft: string): void { this.set({ draft }) }
  setSamples(n: number): void { this.set({ nSamples: Math.min(4, Math.max(1, n)), samplesPicked: true }) }
  /** Forget the browser's pick so the candidate count follows the settings default again. */
  followDefaultSamples(): void {
    const d = this.state.info?.defaultSamples
    this.set({ samplesPicked: false, ...typeof d === 'number' ? { nSamples: Math.min(4, Math.max(1, d)) } : {} })
  }
  setPage(page: State['page']): void { this.set({ page }) }
  setShowDiff(on: boolean): void { this.set({ showDiff: on }) }
  setView(view: State['view']): void { this.set({ view }) }
  setLeftMode(leftMode: State['leftMode']): void { this.set({ leftMode }) }
  clearError(): void { this.set({ error: undefined }) }

  addKeep(term: string): void {
    const t = term.trim()
    if (!t || this.state.keep.includes(t)) return
    this.set((s) => ({ keep: [...s.keep, t].slice(0, 50) }))
  }

  removeKeep(term: string): void { this.set((s) => ({ keep: s.keep.filter((k) => k !== term) })) }

  clearDraft(): void { this.set({ draft: '', job: undefined, document: undefined, stats: undefined, error: undefined, leftMode: 'edit' }) }

  async refreshInfo(): Promise<void> {
    try {
      const info = await getJson<Info & { ok: boolean }>('/info')
      this.set((s) => ({
        info,
        ...!s.samplesPicked && typeof info.defaultSamples === 'number' ? { nSamples: Math.min(4, Math.max(1, info.defaultSamples)) } : {},
      }))
      const h = await getJson<{ health: { ok: boolean; message?: string } }>('/health')
      this.set({ health: h.health })
    } catch (error) {
      this.set({ health: { ok: false, message: (error as Error).message } })
    }
  }

  async importFile(file: File): Promise<void> {
    this.set({ importing: true })
    try {
      const text = await importFile(file)
      this.set({ draft: text, job: undefined, document: undefined, stats: undefined, error: undefined })
      this.toast(`已导入 ${file.name}（${Array.from(text).length} 字符）`, 'ok')
    } catch (error) {
      this.toast(`导入失败：${(error as Error).message}`, 'err')
    } finally {
      this.set({ importing: false })
    }
  }

  /** Apply one stream event. Exported behaviour is covered by tests. */
  apply(e: StreamEvent): void {
    switch (e.event) {
      case 'job': {
        const d = e.data
        this.set((s) => ({
          job: {
            id: d.jobId, nSamples: d.nSamples, keepActive: d.keepActive, keepIgnored: d.keepIgnored, kept: d.kept, draft: s.draft,
            units: d.units.map((u) => ({ ...u, state: 'pending', candidates: [], best: 0, chosen: 0 })),
          },
          document: d.document,
          run: s.run ? { ...s.run, count: d.units.length } : s.run,
        }))
        break
      }
      case 'unit':
        this.updateUnit(e.data.unitId, (u) => ({ ...u, state: 'running', candidates: [], live: undefined }))
        this.set((s) => (s.run ? { run: { ...s.run, position: e.data.position, count: e.data.count, unitId: e.data.unitId } } : {}))
        break
      case 'sample':
        this.updateUnit(e.data.unitId, (u) => ({ ...u, live: { index: e.data.index, text: '' } }))
        break
      case 'partial':
        this.updateUnit(e.data.unitId, (u) => ({ ...u, live: { index: e.data.index, text: e.data.text } }))
        break
      case 'candidate':
        this.updateUnit(e.data.unitId, (u) => {
          const candidates = [...u.candidates]
          candidates[e.data.index] = e.data.candidate
          return { ...u, candidates, live: undefined }
        })
        break
      case 'piece': {
        const p = e.data.piece
        this.updateUnit(p.id, (u) => ({ ...u, state: 'done', candidates: p.candidates, best: p.best, chosen: p.chosen, seconds: p.seconds, live: undefined }))
        break
      }
      case 'document':
        this.set({ document: e.data })
        break
      case 'done':
        this.set((s) => ({
          document: { text: e.data.text, warnings: e.data.warnings, done: e.data.done, total: e.data.total },
          stats: { requests: e.data.requests, seconds: e.data.seconds, cancelled: e.data.cancelled },
          job: s.job ? { ...s.job, units: s.job.units.map((u) => (u.state === 'running' ? { ...u, state: u.candidates.length ? 'done' : 'pending', live: undefined } : u)) } : s.job,
        }))
        break
      case 'error':
        this.set((s) => ({
          error: e.data.message,
          job: s.job && s.run?.unitId !== undefined ? { ...s.job, units: s.job.units.map((u) => (u.id === s.run!.unitId && u.state === 'running' ? { ...u, state: 'error', live: undefined } : u)) } : s.job,
        }))
        break
    }
  }

  private async runStream(path: string, body: unknown, run: RunView): Promise<void> {
    if (this.state.run) return
    const controller = new AbortController()
    this.controller = controller
    this.set({ run, error: undefined, stats: undefined })
    try {
      await postStream(path, body, (e) => { this.apply(e) }, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) this.set({ error: (error as Error).message })
    } finally {
      this.controller = undefined
      this.set((s) => ({
        run: undefined,
        job: s.job ? { ...s.job, units: s.job.units.map((u) => (u.state === 'running' ? { ...u, state: u.candidates.length ? 'done' : 'pending', live: undefined } : u)) } : s.job,
      }))
    }
  }

  async start(): Promise<void> {
    const s = this.state
    if (s.run || !s.draft.trim()) return
    this.set({ job: undefined, document: undefined, view: 'pieces', leftMode: 'compare' })
    await this.runStream('/jobs', { text: s.draft, keep: s.keep.filter((k) => s.draft.includes(k)), n_samples: s.nSamples }, { kind: 'job', startedAt: Date.now(), position: 0, count: 0 })
    const after = this.state
    if (after.stats?.cancelled) this.toast('已停止，已完成的段落保留', '')
    else if (after.document && !after.error) this.toast('改写完成', 'ok')
  }

  async regenerate(unitId: number): Promise<void> {
    const job = this.state.job
    if (!job || this.state.run) return
    await this.runStream(`/jobs/${job.id}/units/${unitId}/regenerate`, { n_samples: this.state.nSamples }, { kind: 'regen', unitId, startedAt: Date.now(), position: 0, count: 1 })
  }

  async stop(): Promise<void> {
    const job = this.state.job
    this.controller?.abort()
    if (job) { try { await postJson(`/jobs/${job.id}/cancel`, {}) } catch { /* already finished */ } }
  }

  async choose(unitId: number, index: number): Promise<void> {
    const job = this.state.job
    if (!job) return
    this.updateUnit(unitId, (u) => ({ ...u, chosen: index }))
    try {
      const r = await postJson<{ document: WireDocument }>(`/jobs/${job.id}/choose`, { unitId, index })
      this.set({ document: r.document })
    } catch (error) {
      this.toast(`切换失败：${(error as Error).message}`, 'err')
    }
  }
}

let shared: HumanizerStore | undefined

export function humanizerStore(): HumanizerStore {
  shared ??= new HumanizerStore()
  return shared
}

/** The 对比 view can show: a job exists and the draft is still the one it rewrote. */
export function canCompare(s: State): boolean {
  return s.job !== undefined && s.job.draft === s.draft
}

/** The left pane shows the 对比 view (wanted and possible). */
export function comparing(s: State): boolean {
  return s.leftMode === 'compare' && canCompare(s)
}
